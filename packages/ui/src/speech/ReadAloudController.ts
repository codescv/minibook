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
  fractionForSessionLocator,
  loadFullSectionText,
  openBookWithHost,
  segmentSectionSafe,
} from '../host/core-bridge';
import { useSettingsStore } from '../host/HostContext';
import { resolveLocale, translate } from '../i18n';
import { AutoPageTurn, type AutoPageTurnViewAdapter } from './AutoPageTurn';
import { KokoroG2PClient, isKokoroCompatibleLang } from './KokoroG2PClient';
import { useSpeechModelStore, isNaturalSystemVoiceEntry } from './speech-model-store';

const MIN_QUEUE_HORIZON = 25;

function normalizeLangTagClean(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/_/g, '-');
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === 'und' || lower === 'mul' || lower === 'zxx' || lower === 'unknown') {
    return null;
  }
  const parts = cleaned.split('-');
  if (parts.length === 1) return parts[0]!.toLowerCase();
  return [
    parts[0]!.toLowerCase(),
    ...parts.slice(1).map((p) => {
      if (p.length === 4 && /^[a-z]+$/i.test(p)) {
        return p[0]!.toUpperCase() + p.slice(1).toLowerCase();
      }
      return p.length === 2 ? p.toUpperCase() : p;
    }),
  ].join('-');
}

/**
 * Resolves the effective book BCP-47 language from container metadata + sampled utterance text (`v0.2.5`):
 * - Chinese `.txt`/`.md` files (`metaLang === null`) or Chinese/Japanese/Korean EPUBs mis-tagged with
 *   `<dc:language>en</dc:language>` adopt `sampleUtteranceLang` (`'zh-CN'`, `'ja'`, `'ko'`).
 * - Bare `'zh'` upgrades to regional `'zh-CN'` when `sampleUtteranceLang` is `'zh-CN'`, while preserving
 *   explicit `'zh-TW'` / `'zh-HK'` metadata.
 */
export function resolveEffectiveBookLang(
  metaLang: string | null | undefined,
  sampleUtteranceLang: string | null | undefined,
): string | null {
  const normMeta = normalizeLangTagClean(metaLang);
  const normSample = normalizeLangTagClean(sampleUtteranceLang);
  const samplePrimary = normSample?.split('-')[0]?.toLowerCase() ?? null;
  const metaPrimary = normMeta?.split('-')[0]?.toLowerCase() ?? null;
  const metaIsCjk = metaPrimary === 'zh' || metaPrimary === 'ja' || metaPrimary === 'ko';

  if (samplePrimary === 'zh' || samplePrimary === 'ja' || samplePrimary === 'ko') {
    // Override only when container metadata is missing/und OR declares a non-CJK language (e.g. `en`).
    // Never overwrite an explicit CJK container language (`ja`, `zh-TW`, `zh-Hant`, `ko`) with `zh-CN`.
    if (!normMeta || !metaIsCjk) {
      return normSample;
    }
    if (normMeta === 'zh' && normSample && normSample.includes('-')) {
      return normSample;
    }
  }
  return normMeta ?? normSample ?? null;
}

function inferSampleUtteranceLang(
  utterances: readonly Utterance[],
  startIdx: number,
  targetUtteranceLang: string | null | undefined,
  metaLang?: string | null | undefined,
): string | null {
  const normMeta = normalizeLangTagClean(metaLang);
  const metaPrimary = normMeta?.split('-')[0]?.toLowerCase() ?? null;
  const normTarget = normalizeLangTagClean(targetUtteranceLang);

  // Container already declares CJK (`zh*`, `ja*`, `ko*`): trust utterance/container tag directly.
  if (metaPrimary === 'zh' || metaPrimary === 'ja' || metaPrimary === 'ko') {
    return normTarget;
  }

  // Sample up to 40 utterances around `startIdx` (backfilling from earlier in `utterances` if near the end).
  const windowSize = 40;
  const winStart =
    utterances.length <= windowSize
      ? 0
      : Math.max(0, Math.min(startIdx, utterances.length - windowSize));
  const windowSlice = utterances.slice(winStart, winStart + windowSize);
  if (windowSlice.length === 0) {
    return normMeta ?? normTarget;
  }

  const counts = new Map<string, { count: number; chars: number; firstTag: string }>();
  let totalChars = 0;
  for (const u of windowSlice) {
    const len = Math.max(1, u.text.trim().length);
    totalChars += len;
    const tag = normalizeLangTagClean(u.lang);
    const p = tag?.split('-')[0]?.toLowerCase();
    if (tag && (p === 'zh' || p === 'ja' || p === 'ko')) {
      const prev = counts.get(p);
      if (prev) {
        prev.count += 1;
        prev.chars += len;
      } else {
        counts.set(p, { count: 1, chars: len, firstTag: tag });
      }
    }
  }

  let bestCjk: { count: number; chars: number; firstTag: string } | null = null;
  for (const entry of counts.values()) {
    if (
      !bestCjk ||
      entry.count > bestCjk.count ||
      (entry.count === bestCjk.count && entry.chars > bestCjk.chars)
    ) {
      bestCjk = entry;
    }
  }

  if (bestCjk) {
    const uttShare = bestCjk.count / windowSlice.length;
    const charShare = totalChars > 0 ? bestCjk.chars / totalChars : 0;
    if (normMeta) {
      // [P1]: Container explicitly declares a non-CJK language (e.g. `<dc:language>en</dc:language>`).
      // Override ONLY on a window majority (> 50%), never on a single CJK epigraph sentence!
      const hasMinCount = windowSlice.length === 1 ? bestCjk.count === 1 : bestCjk.count >= 2;
      if (hasMinCount && (uttShare > 0.5 || (uttShare >= 0.5 && charShare > 0.6))) {
        return bestCjk.firstTag;
      }
      return normMeta;
    }

    // [P2]: Container has no language metadata (`null` / `und`, e.g. `.txt` / `.md`).
    // Pick CJK when its share across the 40-utterance window is >= 30% (handles multi-line English
    // copyright/ISBN front matter ahead of Chinese prose).
    const hasMinCount = windowSlice.length <= 3 ? bestCjk.count >= 1 : bestCjk.count >= 2;
    if (hasMinCount && (uttShare >= 0.3 || charShare >= 0.3)) {
      return bestCjk.firstTag;
    }
    const nonCjk = windowSlice.find((u) => {
      const p = normalizeLangTagClean(u.lang)?.split('-')[0]?.toLowerCase();
      return p && p !== 'zh' && p !== 'ja' && p !== 'ko';
    });
    return normalizeLangTagClean(nonCjk?.lang) ?? normTarget;
  }

  return normMeta ?? normTarget;
}

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
 * - Stocks `SpeechPlayer` until `>= 25` utterances are queued ahead (looping across tiny sections).
 * - Rebuilds contiguous spine queues cleanly on out-of-order / backward seeks (`[P1-U5]`).
 * - Follows manual page turns after a 600ms settle starting at the first sentence that BEGINS
 *   on the new page (`[P1-U4]`), never snapping the user backward.
 */
export class ReadAloudController {
  private readonly host: PlatformHost;
  private readonly player: SpeechPlayer;
  private readonly getSettings: () => AppSettings;
  private readonly getIsEink: () => boolean;
  private readonly autoPageTurn = new AutoPageTurn();
  private readonly g2p: KokoroG2PClient;
  private readonly ownsG2P: boolean;

  private scheduler: SynthScheduler | null = null;
  private unsubPlayer: (() => void) | null = null;
  private unsubHost: (() => void) | null = null;
  private session: BookSession | null = null;
  private ownsSession = false;

  private utterances: Utterance[] = [];
  private utteranceById = new Map<string, Utterance>();
  private attachedDurations = new Map<string, number>();
  private loadedSections = new Set<number>();
  private highestQueuedSection = -1;
  private lowestQueuedSection = Infinity;
  private toppingUp = false;
  private suppressBackwardSnapForId: string | null = null;
  private voiceSwitchGeneration = 0;
  private pendingVoiceSwitchResume: boolean | null = null;
  private g2pPreloaded = false;

  private viewAdapter: AutoPageTurnViewAdapter | null = null;
  private manualTurnDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: {
    readonly host: PlatformHost;
    readonly player: SpeechPlayer;
    readonly getSettings: () => AppSettings;
    readonly getIsEink: () => boolean;
    readonly g2pClient?: KokoroG2PClient;
  }) {
    this.host = deps.host;
    this.player = deps.player;
    this.getSettings = deps.getSettings;
    this.getIsEink = deps.getIsEink;
    if (deps.g2pClient) {
      this.g2p = deps.g2pClient;
      this.ownsG2P = false;
    } else {
      this.g2p = new KokoroG2PClient();
      this.ownsG2P = true;
    }

    this.unsubPlayer = this.player.subscribe((ev) => this.handlePlayerEvent(ev));
    if (this.host.speech.models || this.host.models) {
      void useSpeechModelStore
        .getState()
        .refreshFromHost(this.host)
        .then((st) => {
          if (st?.state === 'ready') {
            this.preloadG2PIfNeeded();
          }
        });
    }
    this.unsubHost = this.host.subscribe((ev) => {
      if (ev.type === 'speech-model') {
        useSpeechModelStore.getState().setStatus(ev.status);
        if (ev.status.state === 'ready') {
          this.preloadG2PIfNeeded();
        }
      }
    });
  }

  private preloadTimer: ReturnType<typeof setTimeout> | null = null;

  private preloadG2PIfNeeded(): void {
    if (this.g2pPreloaded) return;
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent ?? '')) {
      return;
    }
    this.g2pPreloaded = true;
    this.preloadTimer = setTimeout(() => {
      this.preloadTimer = null;
      void this.g2p.preload({ includeEnglish: false }).catch(() => {
        this.g2pPreloaded = false;
      });
    }, 250);
  }

  attachViewAdapter(adapter: AutoPageTurnViewAdapter | null): void {
    this.viewAdapter = adapter;
  }

  onBookOpened(bookId: BookId): void {
    const state = useReadAloudStore.getState();
    if (state.active && state.bookId && state.bookId !== bookId) {
      this.stop();
    }
  }

  resolvePreferredVoice(
    bookLang: string | null,
    sampleUtteranceLang?: string | null,
  ): VoiceRef {
    const settings = this.getSettings();
    const effectiveLang = resolveEffectiveBookLang(bookLang, sampleUtteranceLang);
    const langKey = (effectiveLang?.split('-')[0] ?? 'default').toLowerCase();
    const explicit = settings.preferredVoices[langKey] ?? settings.preferredVoices.default;
    if (explicit) {
      if (explicit.kind === 'edge' && !settings.edgeVoicesEnabled) {
        return { kind: 'system', voiceId: null };
      }
      if (explicit.kind === 'openai' && !settings.customSpeechServer) {
        return { kind: 'system', voiceId: null };
      }
      if (explicit.kind === 'qwen' && !settings.qwenServer) {
        return { kind: 'system', voiceId: null };
      }
      if (explicit.kind === 'kokoro') {
        const modelStatus = useSpeechModelStore.getState().status;
        if (
          !this.host.speech.models ||
          !explicit.voiceId ||
          modelStatus?.state !== 'ready' ||
          !modelStatus.installedVoices.includes(explicit.voiceId)
        ) {
          return { kind: 'system', voiceId: null };
        }
      }
      if (explicit.kind === 'system' && explicit.voiceId) {
        if (
          !isNaturalSystemVoiceEntry({
            id: explicit.voiceId,
            name: '',
            engine: explicit.engine,
          })
        ) {
          return { kind: 'system', voiceId: null };
        }
      }
      return explicit;
    }
    return { kind: 'system', voiceId: null };
  }

  async start(options: {
    readonly bookId: BookId;
    readonly startLocator: Locator;
    readonly pageEndOffset?: number;
    readonly preferContaining?: boolean;
    readonly sharedSession?: BookSession;
    readonly chapterTitle?: string;
  }): Promise<void> {
    const prevState = useReadAloudStore.getState();
    if (prevState.active && prevState.bookId !== options.bookId) {
      this.stop();
    }

    this.clearManualTurnTimer();
    this.suppressBackwardSnapForId = null;

    if (options.sharedSession) {
      this.session = options.sharedSession;
      this.ownsSession = false;
    } else if (!this.session || prevState.bookId !== options.bookId) {
      const detail = await this.host.library.get(options.bookId);
      this.session = await openBookWithHost(this.host, options.bookId, detail);
      this.ownsSession = true;
    }

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

    const settings = this.getSettings();
    const voice = this.resolvePreferredVoice(this.session.meta.language);
    const rate = settings.speechRate;

    await this.rebuildContiguousQueue({
      bookId: options.bookId,
      startLocator: options.startLocator,
      ...(options.pageEndOffset !== undefined ? { pageEndOffset: options.pageEndOffset } : {}),
      preferContaining: options.preferContaining ?? false,
      voice,
      resolveVoiceFromEffectiveLang: true,
      rate,
      sleepTimer: { mode: 'off' },
      chapterTitle: options.chapterTitle ?? this.session.meta.title,
    });

    useRouteStore.getState().setChromeOpen(false);
    useRouteStore.getState().setReadAloudBarOpen(true);
  }

  private pickStartUtterance(options: {
    readonly section: number;
    readonly offset: number;
    readonly pageEndOffset?: number;
    readonly preferContaining: boolean;
  }): Utterance | null {
    if (this.utterances.length === 0) return null;

    if (options.preferContaining) {
      return (
        this.utterances.find(
          (u) =>
            u.section === options.section &&
            options.offset >= u.start &&
            options.offset <= u.end,
        ) ??
        this.utterances.find(
          (u) => u.section === options.section && u.start >= options.offset,
        ) ??
        this.utterances[0]!
      );
    }

    // Spec §4.6 / §8.2: first utterance that BEGINS on the current page (`u.start >= offset && u.start < pageEndOffset`)
    const beginningOnPage = this.utterances.find(
      (u) =>
        u.section === options.section &&
        u.start >= options.offset &&
        (options.pageEndOffset === undefined || u.start < options.pageEndOffset),
    );
    if (beginningOnPage) {
      return beginningOnPage;
    }

    // Fallback when a single long sentence spans the entire page (`u.start < offset < u.end`):
    // suppress backward page-snap so AutoPageTurn never yanks the user back to the previous page!
    const containing = this.utterances.find(
      (u) =>
        u.section === options.section &&
        u.start <= options.offset &&
        u.end > options.offset,
    );
    if (containing) {
      if (containing.start < options.offset) {
        this.suppressBackwardSnapForId = containing.id;
      }
      return containing;
    }

    // Next available utterance at or after `(section, offset)` (e.g. if page tail only had whitespace)
    return (
      this.utterances.find(
        (u) =>
          u.section > options.section ||
          (u.section === options.section && u.start >= options.offset),
      ) ?? this.utterances[0]!
    );
  }

  private async rebuildContiguousQueue(options: {
    readonly bookId: BookId;
    readonly startLocator: Locator;
    readonly pageEndOffset?: number;
    readonly preferContaining: boolean;
    readonly voice: VoiceRef;
    readonly resolveVoiceFromEffectiveLang?: boolean;
    readonly rate: number;
    readonly sleepTimer: SleepTimerConfig;
    readonly chapterTitle: string;
  }): Promise<void> {
    if (!this.session) return;

    this.voiceSwitchGeneration += 1;
    this.pendingVoiceSwitchResume = null;
    this.utterances = [];
    this.utteranceById.clear();
    this.attachedDurations.clear();
    this.loadedSections.clear();
    this.highestQueuedSection = -1;
    this.lowestQueuedSection = options.startLocator.section;

    // Load full starting section (splitting first long utterance when starting mid-section, §8.1 #6)
    await this.loadAndAppendSection(
      options.startLocator.section,
      {
        ...(options.preferContaining && options.startLocator.offset > 0
          ? {
              startOffset: options.startLocator.offset,
              splitFirstLongUtterance: true,
            }
          : options.startLocator.offset > 0 && !options.preferContaining
            ? { splitFirstLongUtterance: false }
            : {}),
      },
      options.voice,
    );

    // Always stock at least the next linear section + loop until >= 25 utterances ahead (`[P2 #1]`)
    const nextLinear = this.findNextLinearSection(options.startLocator.section);
    if (nextLinear !== null) {
      await this.loadAndAppendSection(nextLinear, undefined, options.voice);
    }

    const targetUtterance = this.pickStartUtterance({
      section: options.startLocator.section,
      offset: options.startLocator.offset,
      ...(options.pageEndOffset !== undefined ? { pageEndOffset: options.pageEndOffset } : {}),
      preferContaining: options.preferContaining,
    });

    if (!targetUtterance) return;

    const startIdx = Math.max(
      0,
      this.utterances.findIndex((u) => u.id === targetUtterance.id),
    );
    const sampleLang = inferSampleUtteranceLang(
      this.utterances,
      startIdx,
      targetUtterance.lang,
      this.session.meta.language,
    );
    const effectiveBookLang = resolveEffectiveBookLang(this.session.meta.language, sampleLang);
    const effectiveVoice = options.resolveVoiceFromEffectiveLang
      ? this.resolvePreferredVoice(effectiveBookLang)
      : options.voice;

    await this.stockAheadUntilHorizon(startIdx, MIN_QUEUE_HORIZON, effectiveVoice);

    if (
      !ReadAloudController.isSameVoiceRef(effectiveVoice, options.voice) &&
      effectiveVoice.kind === 'kokoro' &&
      effectiveVoice.voiceId
    ) {
      const reannotated = await this.annotateForVoice(this.utterances, effectiveVoice);
      this.utterances = reannotated;
      this.utteranceById.clear();
      for (const u of reannotated) {
        this.utteranceById.set(u.id, u);
      }
    }

    const activeStartUtterance = this.utterances[startIdx] ?? targetUtterance;
    const settings = this.getSettings();
    const coverUrl = this.host.library.coverUrl(options.bookId);

    useReadAloudStore.setState({
      active: true,
      bookId: options.bookId,
      bookTitle: this.session.meta.title,
      bookAuthor: this.session.meta.authors.join(', '),
      bookLang: effectiveBookLang,
      status: 'playing',
      rate: options.rate,
      voice: effectiveVoice,
      sleepTimer: options.sleepTimer,
      activeUtterance: activeStartUtterance,
      activeWordRange: null,
      slowVoiceRtf: null,
      usingFallback: false,
    });

    await this.player.load({
      bookId: options.bookId,
      title: this.session.meta.title,
      author: this.session.meta.authors.join(', '),
      chapterTitle: options.chapterTitle,
      coverUrl,
      voice: effectiveVoice,
      systemFallback: settings.fallbackToSystemVoice ? { kind: 'system', voiceId: null } : null,
      rate: options.rate,
    });

    if (options.sleepTimer.mode !== 'off') {
      this.player.setSleepTimer(options.sleepTimer);
    }

    const sliceToQueue = this.utterances.slice(startIdx);
    this.player.enqueue(sliceToQueue);
    this.configureSchedulerForVoice(effectiveVoice, sliceToQueue, activeStartUtterance.id);
    this.player.play();
  }

  togglePlayPause(): void {
    const st = useReadAloudStore.getState();
    if (!st.active) return;
    if (
      st.status === 'playing' ||
      st.status === 'buffering' ||
      this.pendingVoiceSwitchResume === true
    ) {
      if (this.pendingVoiceSwitchResume !== null) {
        this.pendingVoiceSwitchResume = false;
      }
      this.player.pause();
      useReadAloudStore.setState({ status: 'paused' });
    } else {
      if (this.pendingVoiceSwitchResume !== null) {
        this.pendingVoiceSwitchResume = true;
        useReadAloudStore.setState({ status: 'buffering' });
        return;
      }
      this.player.play();
    }
  }

  stop(): void {
    this.voiceSwitchGeneration += 1;
    this.pendingVoiceSwitchResume = null;
    this.clearManualTurnTimer();
    this.autoPageTurn.reset();
    this.scheduler?.dispose();
    this.scheduler = null;
    this.suppressBackwardSnapForId = null;

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
    this.highestQueuedSection = -1;
    this.lowestQueuedSection = Infinity;

    useReadAloudStore.getState().reset();
    useRouteStore.getState().setReadAloudBarOpen(false);
  }

  /**
   * Tap-to-seek on a specific sentence inside the currently rendered page (`preferContaining = true`).
   */
  seekToLocator(locator: Locator): boolean {
    const st = useReadAloudStore.getState();
    if (!st.active || !st.bookId || !this.session) return false;

    if (!this.isSectionInContiguousQueue(locator.section)) {
      void this.rebuildContiguousQueue({
        bookId: st.bookId,
        startLocator: locator,
        preferContaining: true,
        voice: st.voice ?? { kind: 'system', voiceId: null },
        rate: st.rate,
        sleepTimer: st.sleepTimer,
        chapterTitle:
          this.session.spine.find((s) => s.index === locator.section)?.title ??
          this.session.meta.title,
      });
      return true;
    }

    const hit = this.pickStartUtterance({
      section: locator.section,
      offset: locator.offset,
      preferContaining: true,
    });
    if (!hit) return false;

    const hitIdx = Math.max(0, this.utterances.findIndex((u) => u.id === hit.id));
    void this.stockAheadUntilHorizon(hitIdx, MIN_QUEUE_HORIZON).then((added) => {
      if (added.length > 0) {
        this.player.enqueue(added);
      }
      this.scheduler?.onUtteranceStart(hit.id);
      this.player.seekTo(hit.id);
    });
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
    useSettingsStore.getState().patchLocal({ speechRate: clamped });
    this.player.setRate(clamped);
    void this.host.settings.update({ speechRate: clamped }).catch(() => {});
  }

  private static isSameVoiceRef(a: VoiceRef | null, b: VoiceRef): boolean {
    if (!a || a.kind !== b.kind || a.voiceId !== b.voiceId) return false;
    if (a.kind === 'system' && b.kind === 'system') return (a.engine ?? null) === (b.engine ?? null);
    if ((a.kind === 'openai' && b.kind === 'openai') || (a.kind === 'qwen' && b.kind === 'qwen')) {
      return a.model === b.model;
    }
    return true;
  }

  setVoice(voice: VoiceRef): void {
    const st = useReadAloudStore.getState();
    const gen = ++this.voiceSwitchGeneration;
    if (!ReadAloudController.isSameVoiceRef(st.voice, voice)) {
      this.attachedDurations.clear();
    }

    const langKey = (st.bookLang?.split('-')[0] ?? 'default').toLowerCase();
    const nextPreferredVoices = {
      ...this.getSettings().preferredVoices,
      [langKey]: voice,
      default: voice,
    };
    useSettingsStore.getState().patchLocal({ preferredVoices: nextPreferredVoices });
    void this.host.settings
      .update({ preferredVoices: nextPreferredVoices })
      .catch(() => {});

    if (!st.active || !this.session || this.utterances.length === 0) {
      this.pendingVoiceSwitchResume = null;
      useReadAloudStore.setState({ voice, slowVoiceRtf: null, usingFallback: false });
      this.player.setVoice(voice);
      return;
    }

    const target = st.activeUtterance ?? this.utterances[0]!;
    const idx = Math.max(0, this.utterances.findIndex((u) => u.id === target.id));
    const wasPlaying =
      this.pendingVoiceSwitchResume !== null
        ? this.pendingVoiceSwitchResume
        : st.status === 'playing' || st.status === 'buffering';

    if (voice.kind !== 'kokoro' || !voice.voiceId) {
      this.pendingVoiceSwitchResume = null;
      useReadAloudStore.setState({
        voice,
        ...(st.activeUtterance ? {} : { activeUtterance: target }),
        slowVoiceRtf: null,
        usingFallback: false,
      });
      this.player.setVoice(voice);
      const slice = this.utterances.slice(idx);
      this.configureSchedulerForVoice(voice, slice, target.id);
      if (wasPlaying) {
        this.player.play();
      }
      return;
    }

    // Switching to a `kokoro` voice mid-Reader:
    // 1. Silence old playback immediately while remembering `wasPlaying` across rapid consecutive taps.
    // 2. Annotate `firstBatch` (`[idx .. idx + 6)`), then call `player.setVoice(voice)` FIRST (purging
    //    stale `attachedAudio`), then `player.enqueue(fullSlice, { replaceFromId: liveCur.id })` so the
    //    native/web queue is NEVER truncated to 4 items, then `player.play()` if `shouldPlay`.
    // 3. Annotate remaining utterances in chunks of 50 per macrotask with in-place `enqueue(chunk)` upserts.
    this.pendingVoiceSwitchResume = wasPlaying;
    if (this.host.info.capabilities.nativeSpeechQueue) {
      this.scheduler?.configure(null);
    }
    if (wasPlaying) {
      this.player.pause();
    }
    useReadAloudStore.setState({
      voice,
      ...(st.activeUtterance ? {} : { activeUtterance: target }),
      status: wasPlaying ? 'buffering' : st.status,
      slowVoiceRtf: null,
      usingFallback: false,
    });

    void (async () => {
      const initialSlice = this.utterances.slice(idx, idx + 6);
      const firstBatch = await this.annotateForVoice(initialSlice, voice);
      if (
        gen !== this.voiceSwitchGeneration ||
        !useReadAloudStore.getState().active ||
        !this.session
      ) {
        return;
      }

      for (let i = 0; i < firstBatch.length; i++) {
        const u = firstBatch[i]!;
        if (idx + i < this.utterances.length) {
          this.utterances[idx + i] = u;
        }
        this.utteranceById.set(u.id, u);
      }

      const liveTarget = useReadAloudStore.getState().activeUtterance ?? target;
      const liveIdx = Math.max(0, this.utterances.findIndex((u) => u.id === liveTarget.id));
      if (!this.utterances[liveIdx]?.phonemeIds) {
        const catchup = await this.annotateForVoice(
          this.utterances.slice(liveIdx, liveIdx + 6),
          voice,
        );
        if (
          gen !== this.voiceSwitchGeneration ||
          !useReadAloudStore.getState().active ||
          !this.session
        ) {
          return;
        }
        for (let i = 0; i < catchup.length; i++) {
          const u = catchup[i]!;
          if (liveIdx + i < this.utterances.length) {
            this.utterances[liveIdx + i] = u;
          }
          this.utteranceById.set(u.id, u);
        }
      }

      const liveCur = this.utterances[liveIdx] ?? target;
      const shouldPlay = this.pendingVoiceSwitchResume ?? false;
      this.pendingVoiceSwitchResume = null;

      const fullSlice = this.utterances.slice(liveIdx);
      this.player.setVoice(voice);
      this.player.enqueue(fullSlice, { replaceFromId: liveCur.id });
      this.configureSchedulerForVoice(voice, fullSlice, liveCur.id);
      if (shouldPlay) {
        this.player.play();
      }

      let offset = liveIdx + 6;
      while (offset < this.utterances.length) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (
          gen !== this.voiceSwitchGeneration ||
          !useReadAloudStore.getState().active ||
          !this.session
        ) {
          return;
        }

        const rawChunk = this.utterances.slice(offset, offset + 50);
        if (rawChunk.length === 0) break;
        const annotatedChunk = await this.annotateForVoice(rawChunk, voice);
        if (
          gen !== this.voiceSwitchGeneration ||
          !useReadAloudStore.getState().active ||
          !this.session
        ) {
          return;
        }

        for (let i = 0; i < annotatedChunk.length; i++) {
          const u = annotatedChunk[i]!;
          if (offset + i < this.utterances.length) {
            this.utterances[offset + i] = u;
          }
          this.utteranceById.set(u.id, u);
        }

        this.player.enqueue(annotatedChunk);
        const nowActiveId = useReadAloudStore.getState().activeUtterance?.id ?? liveCur.id;
        const nowIdx = Math.max(0, this.utterances.findIndex((u) => u.id === nowActiveId));
        if (!this.host.info.capabilities.nativeSpeechQueue) {
          this.scheduler?.setQueue(this.utterances.slice(nowIdx), nowActiveId);
        }
        offset += 50;
      }
    })().catch(() => {
      if (gen === this.voiceSwitchGeneration) {
        this.pendingVoiceSwitchResume = null;
      }
    });
  }

  setSleepTimer(config: SleepTimerConfig): void {
    useReadAloudStore.setState({ sleepTimer: config });
    this.player.setSleepTimer(config);
  }

  /**
   * Turning a page manually (or jumping chapters via TOC/scrubber) while speaking moves the voice
   * after a 600ms settle (`PRODUCT_DESIGN.md` §4.6), starting at the first sentence that BEGINS
   * on the new page (`[P1-U4]`) and rebuilding contiguous spine order if out-of-range (`[P1-U5]`).
   */
  notifyManualPageTurn(firstVisibleLocator: Locator, pageEndOffset?: number): void {
    const st = useReadAloudStore.getState();
    if (!st.active || (st.status !== 'playing' && st.status !== 'buffering')) return;

    this.clearManualTurnTimer();
    this.manualTurnDebounce = setTimeout(() => {
      this.manualTurnDebounce = null;
      const nowState = useReadAloudStore.getState();
      if (
        !nowState.active ||
        !nowState.bookId ||
        !this.session ||
        (nowState.status !== 'playing' && nowState.status !== 'buffering')
      ) {
        return;
      }
      void this.seekToPageRange(nowState.bookId, firstVisibleLocator, pageEndOffset);
    }, 600);
  }

  private isSectionInContiguousQueue(sectionIndex: number): boolean {
    return (
      this.loadedSections.has(sectionIndex) &&
      sectionIndex >= this.lowestQueuedSection &&
      sectionIndex <= this.highestQueuedSection
    );
  }

  private async seekToPageRange(
    bookId: BookId,
    pageStart: Locator,
    pageEndOffset?: number,
  ): Promise<void> {
    const st = useReadAloudStore.getState();
    if (!this.session) return;

    // Out-of-order jump (e.g. backward to an earlier chapter or past buffered horizon):
    // rebuild contiguous queue from `pageStart.section` so `highestQueuedSection` and player queue never skip chapters!
    if (!this.isSectionInContiguousQueue(pageStart.section)) {
      await this.rebuildContiguousQueue({
        bookId,
        startLocator: pageStart,
        ...(pageEndOffset !== undefined ? { pageEndOffset } : {}),
        preferContaining: false,
        voice: st.voice ?? { kind: 'system', voiceId: null },
        rate: st.rate,
        sleepTimer: st.sleepTimer,
        chapterTitle:
          this.session.spine.find((s) => s.index === pageStart.section)?.title ??
          this.session.meta.title,
      });
      return;
    }

    const hit = this.pickStartUtterance({
      section: pageStart.section,
      offset: pageStart.offset,
      ...(pageEndOffset !== undefined ? { pageEndOffset } : {}),
      preferContaining: false,
    });
    if (!hit) return;

    const hitIdx = Math.max(0, this.utterances.findIndex((u) => u.id === hit.id));
    const added = await this.stockAheadUntilHorizon(hitIdx, MIN_QUEUE_HORIZON);

    // Note: if seeking backward within `this.utterances` to an utterance earlier than what was
    // originally passed to `player.enqueue`, rebuild the player queue from `hit` so `player.seekTo` always finds it!
    await this.reloadPlayerFromIndex(hitIdx, bookId);
    if (added.length > 0 && this.scheduler) {
      this.scheduler.setQueue(this.utterances.slice(hitIdx), hit.id);
    }
  }

  private async reloadPlayerFromIndex(startIdx: number, bookId: BookId): Promise<void> {
    if (!this.session) return;
    const target = this.utterances[startIdx];
    if (!target) return;
    const st = useReadAloudStore.getState();
    const settings = this.getSettings();
    const voice = st.voice ?? { kind: 'system', voiceId: null };
    const coverUrl = this.host.library.coverUrl(bookId);

    await this.player.load({
      bookId,
      title: this.session.meta.title,
      author: this.session.meta.authors.join(', '),
      chapterTitle:
        this.session.spine.find((s) => s.index === target.section)?.title ??
        this.session.meta.title,
      coverUrl,
      voice,
      systemFallback: settings.fallbackToSystemVoice ? { kind: 'system', voiceId: null } : null,
      rate: st.rate,
    });

    if (st.sleepTimer.mode !== 'off') {
      this.player.setSleepTimer(st.sleepTimer);
    }

    const slice = this.utterances.slice(startIdx);
    this.player.enqueue(slice);
    this.configureSchedulerForVoice(voice, slice, target.id);
    this.player.play();
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
    if (this.preloadTimer !== null) {
      clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
    }
    this.stop();
    this.unsubPlayer?.();
    this.unsubPlayer = null;
    this.unsubHost?.();
    this.unsubHost = null;
    if (this.ownsG2P) {
      this.g2p.dispose();
    }
  }

  async annotateForVoice(
    utterances: readonly Utterance[],
    voice: VoiceRef,
  ): Promise<Utterance[]> {
    if (voice.kind !== 'kokoro' || !voice.voiceId) {
      return [...utterances];
    }
    const out: Utterance[] = [];
    for (const u of utterances) {
      if (!isKokoroCompatibleLang(u.lang)) {
        out.push(u);
        continue;
      }
      try {
        const res = await this.g2p.phonemize(u.text, u.lang, { voiceId: voice.voiceId });
        out.push({
          ...u,
          phonemeIds: res.phonemeIds,
          phonemeSpeeds: res.phonemeSpeeds,
          phonemeSpans: res.phonemeSpans,
        });
      } catch {
        out.push(u);
      }
    }
    return out;
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
    } else if (voice.kind === 'kokoro') {
      if (this.host.info.capabilities.nativeSpeechQueue) {
        this.scheduler.configure(null);
        return;
      }
      this.scheduler.configure({
        engine: 'kokoro',
        voiceId: voice.voiceId,
        maxConcurrency: 1,
      });
    } else if (voice.kind === 'qwen') {
      this.scheduler.configure({
        engine: 'qwen',
        voiceId: voice.voiceId,
        model: voice.model,
        ...(settings.qwenServer?.baseUrl ? { baseUrl: settings.qwenServer.baseUrl } : {}),
        maxConcurrency: 1,
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

  private async loadAndAppendSection(
    sectionIndex: number,
    segOpts?: { readonly startOffset?: number; readonly splitFirstLongUtterance?: boolean },
    voiceOverride?: VoiceRef,
  ): Promise<Utterance[]> {
    if (!this.session || this.loadedSections.has(sectionIndex)) return [];
    this.loadedSections.add(sectionIndex);

    const sectionText = await loadFullSectionText(this.session, sectionIndex);

    const rawSegs = segmentSectionSafe(sectionIndex, sectionText, {
      bookLang: this.session.meta.language,
      ...(segOpts?.startOffset !== undefined ? { startOffset: segOpts.startOffset } : {}),
      ...(segOpts?.splitFirstLongUtterance !== undefined
        ? { splitFirstLongUtterance: segOpts.splitFirstLongUtterance }
        : {}),
    });

    const activeVoice = voiceOverride ?? useReadAloudStore.getState().voice;
    const segs =
      activeVoice && activeVoice.kind === 'kokoro'
        ? await this.annotateForVoice(rawSegs, activeVoice)
        : rawSegs;

    const added: Utterance[] = [];
    for (const u of segs) {
      if (!this.utteranceById.has(u.id)) {
        this.utterances.push(u);
        this.utteranceById.set(u.id, u);
        added.push(u);
      }
    }
    if (sectionIndex > this.highestQueuedSection) {
      this.highestQueuedSection = sectionIndex;
    }
    if (sectionIndex < this.lowestQueuedSection) {
      this.lowestQueuedSection = sectionIndex;
    }
    return added;
  }

  /**
   * Loops across consecutive linear sections until at least `minAhead` utterances are queued
   * after `fromIndex` or the book's spine ends (`[P2 #1]`: handles tiny 31-char sections cleanly).
   */
  private async stockAheadUntilHorizon(
    fromIndex: number,
    minAhead: number,
    voiceOverride?: VoiceRef,
  ): Promise<Utterance[]> {
    const newlyAdded: Utterance[] = [];
    while (this.utterances.length - fromIndex < minAhead) {
      const nextSec = this.findNextLinearSection(this.highestQueuedSection);
      if (nextSec === null) break;
      const chunk = await this.loadAndAppendSection(nextSec, undefined, voiceOverride);
      newlyAdded.push(...chunk);
    }
    return newlyAdded;
  }

  private async topUpNextSection(): Promise<void> {
    if (this.toppingUp || !this.session) return;
    this.toppingUp = true;
    try {
      const cur = useReadAloudStore.getState().activeUtterance;
      const curIdx = cur ? Math.max(0, this.utterances.findIndex((u) => u.id === cur.id)) : 0;
      const added = await this.stockAheadUntilHorizon(curIdx, MIN_QUEUE_HORIZON);
      if (added.length > 0) {
        this.player.enqueue(added);
        this.scheduler?.setQueue(this.utterances.slice(curIdx), cur?.id ?? null);
      }
    } finally {
      this.toppingUp = false;
    }
  }

  private persistUtterancePosition(bookId: BookId, u: Utterance): void {
    if (!this.session) return;
    const fraction = fractionForSessionLocator(this.session, {
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
        if (this.pendingVoiceSwitchResume === true && ev.state.status === 'paused') {
          break;
        }
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
        const suppressBackwardSnap = this.suppressBackwardSnapForId === u.id;
        if (suppressBackwardSnap) {
          this.suppressBackwardSnapForId = null;
        }
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
          ...(suppressBackwardSnap ? { suppressBackwardSnap: true } : {}),
        });
        break;
      }

      case 'utterance-word': {
        if (this.getIsEink()) break;
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
        void this.topUpNextSection().catch(() => {});
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

      case 'engine-slow':
        useReadAloudStore.setState({ slowVoiceRtf: Math.round(ev.rtf * 10) / 10 });
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
