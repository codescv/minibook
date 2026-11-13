import { create } from 'zustand';
import type {
  AppSettings,
  AttachedAudio,
  BookId,
  BookSession,
  Locator,
  PlatformHost,
  SleepTimerConfig,
  SpeechPlayer,
  SpeechStatus,
  SynthScheduler,
  Utterance,
  VoiceRef,
} from '@minibook/core';
import { useRouteStore } from '../app/routes';
import {
  createSynthScheduler,
  fractionForLocator,
  openBookWithHost,
  segmentSectionSafe,
} from '../host/core-bridge';
import { resolveLocale, translate } from '../i18n';
import { AutoPageTurn, type AutoPageTurnViewAdapter } from './AutoPageTurn';

export interface ReadAloudStoreState {
  active: boolean;
  bookId: BookId | null;
  bookTitle: string;
  bookAuthor: string;
  bookLang: string | null;
  status: SpeechStatus;
  rate: number;
  voice: VoiceRef | null;
  sleepTimer: SleepTimerConfig;
  activeUtterance: Utterance | null;
  activeWordRange: { readonly start: number; readonly end: number } | null;
  slowVoiceRtf: number | null;
  usingFallback: boolean;
  reset(): void;
}

const INITIAL_RA_STATE = {
  active: false,
  bookId: null as BookId | null,
  bookTitle: '',
  bookAuthor: '',
  bookLang: null as string | null,
  status: 'idle' as SpeechStatus,
  rate: 1.0,
  voice: null as VoiceRef | null,
  sleepTimer: { mode: 'off' } as SleepTimerConfig,
  activeUtterance: null as Utterance | null,
  activeWordRange: null as { readonly start: number; readonly end: number } | null,
  slowVoiceRtf: null as number | null,
  usingFallback: false,
};

export const useReadAloudStore = create<ReadAloudStoreState>((set) => ({
  ...INITIAL_RA_STATE,
  reset() {
    set({ ...INITIAL_RA_STATE });
  },
}));

/**
 * App-scoped Read-Aloud orchestrator (`ARCHITECTURE.md` §8.2).
 *
 * Lives for the entire session independent of `ReaderScreen` mounting:
 * - Enforces the single-book rule: opening another book cleanly stops the previous session.
 * - Stocks `SpeechPlayer` with current + next section utterances and tops up on `queue-low`.
 * - Drives `SynthScheduler` prefetch + RTF slow-voice warnings.
 * - Follows manual page turns after a 600ms settle (`PRODUCT_DESIGN.md` §4.6).
 */
export class ReadAloudController {
  private readonly host: PlatformHost;
  private readonly player: SpeechPlayer;
  private readonly getSettings: () => AppSettings;
  private readonly getIsEink: () => boolean;
  private readonly autoPageTurn = new AutoPageTurn();

  private scheduler: SynthScheduler | null = null;
  private unsubPlayer: (() => void) | null = null;
  private session: BookSession | null = null;
  private ownsSession = false;

  private utterances: Utterance[] = [];
  private utteranceById = new Map<string, Utterance>();
  private attachedDurations = new Map<string, number>();
  private loadedSections = new Set<number>();
  private highestQueuedSection = -1;
  private toppingUp = false;

  private viewAdapter: AutoPageTurnViewAdapter | null = null;
  private manualTurnDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: {
    readonly host: PlatformHost;
    readonly player: SpeechPlayer;
    readonly getSettings: () => AppSettings;
    readonly getIsEink: () => boolean;
  }) {
    this.host = deps.host;
    this.player = deps.player;
    this.getSettings = deps.getSettings;
    this.getIsEink = deps.getIsEink;

    this.unsubPlayer = this.player.subscribe((ev) => this.handlePlayerEvent(ev));
  }

  attachViewAdapter(adapter: AutoPageTurnViewAdapter | null): void {
    this.viewAdapter = adapter;
  }

  /**
   * Enforces "One book at a time" (`PRODUCT_DESIGN.md` §6 & `ARCHITECTURE.md` §8.2):
   * Opening a different book stops any active Read-Aloud session first.
   */
  onBookOpened(bookId: BookId): void {
    const state = useReadAloudStore.getState();
    if (state.active && state.bookId && state.bookId !== bookId) {
      this.stop();
    }
  }

  resolvePreferredVoice(bookLang: string | null): VoiceRef {
    const settings = this.getSettings();
    const langKey = (bookLang?.split('-')[0] ?? 'default').toLowerCase();
    const explicit = settings.preferredVoices[langKey] ?? settings.preferredVoices.default;
    if (explicit) {
      if (explicit.kind === 'edge' && !settings.edgeVoicesEnabled) {
        return { kind: 'system', voiceId: null };
      }
      if (explicit.kind === 'openai' && !settings.customSpeechServer) {
        return { kind: 'system', voiceId: null };
      }
      return explicit;
    }
    return { kind: 'system', voiceId: null };
  }

  async start(options: {
    readonly bookId: BookId;
    readonly startLocator: Locator;
    readonly sharedSession?: BookSession;
    readonly chapterTitle?: string;
  }): Promise<void> {
    const prevState = useReadAloudStore.getState();
    if (prevState.active && prevState.bookId !== options.bookId) {
      this.stop();
    }

    this.clearManualTurnTimer();
    this.utterances = [];
    this.utteranceById.clear();
    this.attachedDurations.clear();
    this.loadedSections.clear();
    this.highestQueuedSection = -1;

    if (options.sharedSession) {
      this.session = options.sharedSession;
      this.ownsSession = false;
    } else {
      const detail = await this.host.library.get(options.bookId);
      this.session = await openBookWithHost(this.host, options.bookId, detail);
      this.ownsSession = true;
    }

    const settings = this.getSettings();
    const voice = this.resolvePreferredVoice(this.session.meta.language);
    const rate = settings.speechRate;
    const coverUrl = this.host.library.coverUrl(options.bookId);

    this.scheduler?.dispose();
    this.scheduler = createSynthScheduler({
      synthesize: (req, signal) => this.host.speech.synthesize(req, signal),
      attachAudio: (id: string, audio: AttachedAudio) => {
        if (audio.durationMs !== undefined) {
          this.attachedDurations.set(id, audio.durationMs);
        }
        this.player.attachAudio(id, audio);
      },
      onEngineSlow: ({ rtf }) => {
        useReadAloudStore.setState({ slowVoiceRtf: Math.round(rtf * 10) / 10 });
      },
      isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    });

    await this.loadAndAppendSection(options.startLocator.section);
    const nextLinear = this.findNextLinearSection(options.startLocator.section);
    if (nextLinear !== null) {
      await this.loadAndAppendSection(nextLinear);
    }

    if (this.utterances.length === 0) {
      return;
    }

    // Pick first utterance starting >= startLocator.offset, or containing startLocator.offset
    const targetUtterance =
      this.utterances.find(
        (u) =>
          u.section === options.startLocator.section &&
          (u.start >= options.startLocator.offset || u.end > options.startLocator.offset),
      ) ?? this.utterances[0]!;

    useReadAloudStore.setState({
      active: true,
      bookId: options.bookId,
      bookTitle: this.session.meta.title,
      bookAuthor: this.session.meta.authors.join(', '),
      bookLang: this.session.meta.language,
      status: 'playing',
      rate,
      voice,
      sleepTimer: { mode: 'off' },
      activeUtterance: targetUtterance,
      activeWordRange: null,
      slowVoiceRtf: null,
      usingFallback: false,
    });

    await this.player.load({
      bookId: options.bookId,
      title: this.session.meta.title,
      author: this.session.meta.authors.join(', '),
      chapterTitle: options.chapterTitle ?? this.session.meta.title,
      coverUrl,
      voice,
      systemFallback: settings.fallbackToSystemVoice ? { kind: 'system', voiceId: null } : null,
      rate,
    });

    const startIdx = Math.max(0, this.utterances.findIndex((u) => u.id === targetUtterance.id));
    const sliceToQueue = this.utterances.slice(startIdx);
    this.player.enqueue(sliceToQueue);
    this.configureSchedulerForVoice(voice, sliceToQueue, targetUtterance.id);
    this.player.play();

    // Normal mode shows floating bar for 4s; E-Ink mode keeps ReadAloudBar hidden while speaking unless summoned (`§8.2 R4`)
    useRouteStore.getState().setChromeOpen(false);
    useRouteStore.getState().setReadAloudBarOpen(!this.getIsEink());
  }

  togglePlayPause(): void {
    const st = useReadAloudStore.getState();
    if (!st.active) return;
    if (st.status === 'playing' || st.status === 'buffering') {
      this.player.pause();
    } else {
      this.player.play();
    }
  }

  stop(): void {
    this.clearManualTurnTimer();
    this.autoPageTurn.reset();
    this.scheduler?.dispose();
    this.scheduler = null;

    const st = useReadAloudStore.getState();
    if (st.active && st.bookId && st.activeUtterance && this.session) {
      this.persistUtterancePosition(st.bookId, st.activeUtterance);
    }

    this.player.stop();
    if (this.ownsSession && this.session) {
      this.session.close();
    }
    this.session = null;
    this.ownsSession = false;
    this.utterances = [];
    this.utteranceById.clear();
    this.loadedSections.clear();

    useReadAloudStore.getState().reset();
    useRouteStore.getState().setReadAloudBarOpen(false);
  }

  seekToLocator(locator: Locator): boolean {
    const st = useReadAloudStore.getState();
    if (!st.active) return false;
    const hit = this.utterances.find(
      (u) =>
        u.section === locator.section &&
        locator.offset >= u.start &&
        locator.offset <= u.end,
    ) ?? this.utterances.find(
      (u) => u.section === locator.section && u.start >= locator.offset,
    );
    if (!hit) return false;
    this.scheduler?.onUtteranceStart(hit.id);
    this.player.seekTo(hit.id);
    return true;
  }

  stepSentence(delta: -1 | 1): void {
    const cur = useReadAloudStore.getState().activeUtterance;
    if (!cur) return;
    const idx = this.utterances.findIndex((u) => u.id === cur.id);
    if (idx < 0) return;
    const target = this.utterances[Math.max(0, Math.min(this.utterances.length - 1, idx + delta))];
    if (target) {
      this.scheduler?.onUtteranceStart(target.id);
      this.player.seekTo(target.id);
    }
  }

  stepParagraph(delta: -1 | 1): void {
    const cur = useReadAloudStore.getState().activeUtterance;
    if (!cur) return;
    const idx = this.utterances.findIndex((u) => u.id === cur.id);
    if (idx < 0) return;

    if (delta > 0) {
      for (let i = idx + 1; i < this.utterances.length; i++) {
        const cand = this.utterances[i]!;
        if (cand.section !== cur.section || cand.blockIndex !== cur.blockIndex) {
          this.scheduler?.onUtteranceStart(cand.id);
          this.player.seekTo(cand.id);
          return;
        }
      }
    } else {
      let targetBlock = -1;
      let targetSection = -1;
      for (let i = idx - 1; i >= 0; i--) {
        const cand = this.utterances[i]!;
        if (cand.section !== cur.section || cand.blockIndex !== cur.blockIndex) {
          targetBlock = cand.blockIndex;
          targetSection = cand.section;
          break;
        }
      }
      if (targetSection >= 0) {
        const firstInBlock = this.utterances.find(
          (u) => u.section === targetSection && u.blockIndex === targetBlock,
        );
        if (firstInBlock) {
          this.scheduler?.onUtteranceStart(firstInBlock.id);
          this.player.seekTo(firstInBlock.id);
        }
      }
    }
  }

  setRate(nextRate: number): void {
    const clamped = Math.max(0.5, Math.min(3.0, Math.round(nextRate * 10) / 10));
    useReadAloudStore.setState({ rate: clamped });
    this.player.setRate(clamped);
    void this.host.settings.update({ speechRate: clamped }).catch(() => {});
  }

  setVoice(voice: VoiceRef): void {
    const st = useReadAloudStore.getState();
    useReadAloudStore.setState({ voice, slowVoiceRtf: null, usingFallback: false });
    this.player.setVoice(voice);

    if (st.activeUtterance) {
      const idx = Math.max(0, this.utterances.findIndex((u) => u.id === st.activeUtterance!.id));
      this.configureSchedulerForVoice(voice, this.utterances.slice(idx), st.activeUtterance.id);
    }

    const langKey = (st.bookLang?.split('-')[0] ?? 'default').toLowerCase();
    const currentPrefs = this.getSettings().preferredVoices;
    void this.host.settings
      .update({
        preferredVoices: {
          ...currentPrefs,
          [langKey]: voice,
        },
      })
      .catch(() => {});
  }

  setSleepTimer(config: SleepTimerConfig): void {
    useReadAloudStore.setState({ sleepTimer: config });
    this.player.setSleepTimer(config);
  }

  /**
   * Turning a page manually while speaking moves the voice after a 600ms settle (`PRODUCT_DESIGN.md` §4.6).
   */
  notifyManualPageTurn(firstVisibleLocator: Locator): void {
    const st = useReadAloudStore.getState();
    if (!st.active || (st.status !== 'playing' && st.status !== 'buffering')) return;

    this.clearManualTurnTimer();
    this.manualTurnDebounce = setTimeout(() => {
      this.manualTurnDebounce = null;
      const nowState = useReadAloudStore.getState();
      if (!nowState.active || (nowState.status !== 'playing' && nowState.status !== 'buffering')) {
        return;
      }
      void this.ensureSectionLoadedAndSeek(firstVisibleLocator);
    }, 600);
  }

  async reconcileOnWake(): Promise<void> {
    if (!useReadAloudStore.getState().active) return;
    try {
      const state = await this.player.getState();
      useReadAloudStore.setState({ status: state.status, usingFallback: state.usingFallback });
      if (state.currentUtteranceId) {
        const u = this.utteranceById.get(state.currentUtteranceId);
        if (u) {
          useReadAloudStore.setState({ activeUtterance: u });
          if (this.viewAdapter) {
            this.viewAdapter.jumpToLocator({ section: u.section, offset: u.start });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  dispose(): void {
    this.stop();
    this.unsubPlayer?.();
    this.unsubPlayer = null;
  }

  private async ensureSectionLoadedAndSeek(locator: Locator): Promise<void> {
    if (!this.loadedSections.has(locator.section)) {
      await this.loadAndAppendSection(locator.section);
      const fromHere = this.utterances.filter((u) => u.section === locator.section);
      this.player.enqueue(fromHere);
    }
    this.seekToLocator(locator);
  }

  private configureSchedulerForVoice(
    voice: VoiceRef,
    queueSlice: readonly Utterance[],
    currentId: string | null,
  ): void {
    if (!this.scheduler) return;
    if (voice.kind === 'system') {
      this.scheduler.configure(null);
      return;
    }
    const settings = this.getSettings();
    if (voice.kind === 'edge') {
      this.scheduler.configure({
        engine: 'edge',
        voiceId: voice.voiceId,
        maxConcurrency: 2,
      });
    } else {
      this.scheduler.configure({
        engine: 'openai',
        voiceId: voice.voiceId,
        model: voice.model,
        ...(settings.customSpeechServer?.baseUrl
          ? { baseUrl: settings.customSpeechServer.baseUrl }
          : {}),
        maxConcurrency: 2,
      });
    }
    this.scheduler.setQueue(queueSlice, currentId);
  }

  private findNextLinearSection(afterSection: number): number | null {
    if (!this.session) return null;
    for (const s of this.session.spine) {
      if (s.index > afterSection && s.linear) {
        return s.index;
      }
    }
    return null;
  }

  private async loadAndAppendSection(sectionIndex: number): Promise<void> {
    if (!this.session || this.loadedSections.has(sectionIndex)) return;
    this.loadedSections.add(sectionIndex);

    const sectionText = this.session.loadSectionText
      ? await this.session.loadSectionText(sectionIndex)
      : (await this.session.loadSection(sectionIndex)).text;

    const segs = segmentSectionSafe(sectionIndex, sectionText, {
      bookLang: this.session.meta.language,
    });

    for (const u of segs) {
      if (!this.utteranceById.has(u.id)) {
        this.utterances.push(u);
        this.utteranceById.set(u.id, u);
      }
    }
    if (sectionIndex > this.highestQueuedSection) {
      this.highestQueuedSection = sectionIndex;
    }
  }

  private async topUpNextSection(): Promise<void> {
    if (this.toppingUp || !this.session) return;
    const nextSec = this.findNextLinearSection(this.highestQueuedSection);
    if (nextSec === null) return;

    this.toppingUp = true;
    try {
      const prevLen = this.utterances.length;
      await this.loadAndAppendSection(nextSec);
      const added = this.utterances.slice(prevLen);
      if (added.length > 0) {
        this.player.enqueue(added);
        const cur = useReadAloudStore.getState().activeUtterance;
        this.scheduler?.setQueue(this.utterances, cur?.id ?? null);
      }
    } finally {
      this.toppingUp = false;
    }
  }

  private persistUtterancePosition(bookId: BookId, u: Utterance): void {
    if (!this.session) return;
    const fraction = fractionForLocator(this.session.spine, {
      section: u.section,
      offset: u.start,
    });
    void this.host.state
      .savePosition(bookId, {
        section: u.section,
        offset: u.start,
        fraction,
        snippet: u.text.slice(0, 32),
        updatedAt: Date.now(),
      })
      .catch(() => {});
  }

  private handlePlayerEvent(ev: Parameters<Parameters<SpeechPlayer['subscribe']>[0]>[0]): void {
    const st = useReadAloudStore.getState();
    if (!st.active) return;

    switch (ev.type) {
      case 'speech-state':
        useReadAloudStore.setState({
          status: ev.state.status,
          usingFallback: ev.state.usingFallback,
        });
        break;

      case 'utterance-start': {
        const u = this.utteranceById.get(ev.id) ?? {
          id: ev.id,
          section: ev.section,
          start: ev.start,
          end: ev.end,
          blockIndex: 0,
          text: '',
          lang: st.bookLang ?? 'en',
          pauseAfterMs: 200,
        };
        useReadAloudStore.setState({
          activeUtterance: u,
          activeWordRange: null,
          usingFallback: Boolean(ev.usingFallback),
        });
        this.scheduler?.onUtteranceStart(u.id);
        if (st.bookId) {
          this.persistUtterancePosition(st.bookId, u);
        }
        const attachedDur = this.attachedDurations.get(u.id);
        this.autoPageTurn.onUtteranceStart(u, this.viewAdapter, {
          rate: st.rate,
          ...(attachedDur !== undefined ? { attachedDurationMs: attachedDur } : {}),
        });
        break;
      }

      case 'utterance-word': {
        if (this.getIsEink()) break; // R4: zero word-level repaints in E-Ink mode
        const u = this.utteranceById.get(ev.id) ?? st.activeUtterance;
        if (!u) break;
        useReadAloudStore.setState({
          activeWordRange: {
            start: u.start + ev.start,
            end: u.start + ev.end,
          },
        });
        this.autoPageTurn.onUtteranceWord(u, ev.start, this.viewAdapter);
        break;
      }

      case 'queue-low':
        void this.topUpNextSection();
        break;

      case 'speech-fallback': {
        useReadAloudStore.setState({ usingFallback: true });
        const locale = resolveLocale();
        useRouteStore.getState().showNotice(translate(locale, 'fallbackNotice'));
        break;
      }

      case 'sleep-timer':
        if (ev.expired) {
          useReadAloudStore.setState({ sleepTimer: { mode: 'off' }, status: 'paused' });
        }
        break;

      case 'speech-ended':
        if (ev.reason === 'completed') {
          useReadAloudStore.setState({ status: 'paused', activeWordRange: null });
        }
        break;

      default:
        break;
    }
  }

  private clearManualTurnTimer(): void {
    if (this.manualTurnDebounce !== null) {
      clearTimeout(this.manualTurnDebounce);
      this.manualTurnDebounce = null;
    }
  }
}
