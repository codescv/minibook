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
import { resolveLocale, translate } from '../i18n';
import { AutoPageTurn, type AutoPageTurnViewAdapter } from './AutoPageTurn';

const MIN_QUEUE_HORIZON = 25;

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

  private scheduler: SynthScheduler | null = null;
  private unsubPlayer: (() => void) | null = null;
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
      rate,
      sleepTimer: { mode: 'off' },
      chapterTitle: options.chapterTitle ?? this.session.meta.title,
    });

    useRouteStore.getState().setChromeOpen(false);
    useRouteStore.getState().setReadAloudBarOpen(!this.getIsEink());
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
    readonly rate: number;
    readonly sleepTimer: SleepTimerConfig;
    readonly chapterTitle: string;
  }): Promise<void> {
    if (!this.session) return;

    this.utterances = [];
    this.utteranceById.clear();
    this.attachedDurations.clear();
    this.loadedSections.clear();
    this.highestQueuedSection = -1;
    this.lowestQueuedSection = options.startLocator.section;

    // Load full starting section (splitting first long utterance when starting mid-section, §8.1 #6)
    await this.loadAndAppendSection(options.startLocator.section, {
      ...(options.preferContaining && options.startLocator.offset > 0
        ? {
            startOffset: options.startLocator.offset,
            splitFirstLongUtterance: true,
          }
        : options.startLocator.offset > 0 && !options.preferContaining
          ? { splitFirstLongUtterance: false }
          : {}),
    });

    // Always stock at least the next linear section + loop until >= 25 utterances ahead (`[P2 #1]`)
    const nextLinear = this.findNextLinearSection(options.startLocator.section);
    if (nextLinear !== null) {
      await this.loadAndAppendSection(nextLinear);
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
    await this.stockAheadUntilHorizon(startIdx, MIN_QUEUE_HORIZON);

    const settings = this.getSettings();
    const coverUrl = this.host.library.coverUrl(options.bookId);

    useReadAloudStore.setState({
      active: true,
      bookId: options.bookId,
      bookTitle: this.session.meta.title,
      bookAuthor: this.session.meta.authors.join(', '),
      bookLang: this.session.meta.language,
      status: 'playing',
      rate: options.rate,
      voice: options.voice,
      sleepTimer: options.sleepTimer,
      activeUtterance: targetUtterance,
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
      voice: options.voice,
      systemFallback: settings.fallbackToSystemVoice ? { kind: 'system', voiceId: null } : null,
      rate: options.rate,
    });

    if (options.sleepTimer.mode !== 'off') {
      this.player.setSleepTimer(options.sleepTimer);
    }

    const sliceToQueue = this.utterances.slice(startIdx);
    this.player.enqueue(sliceToQueue);
    this.configureSchedulerForVoice(options.voice, sliceToQueue, targetUtterance.id);
    this.player.play();
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
    this.stop();
    this.unsubPlayer?.();
    this.unsubPlayer = null;
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

  private async loadAndAppendSection(
    sectionIndex: number,
    segOpts?: { readonly startOffset?: number; readonly splitFirstLongUtterance?: boolean },
  ): Promise<Utterance[]> {
    if (!this.session || this.loadedSections.has(sectionIndex)) return [];
    this.loadedSections.add(sectionIndex);

    const sectionText = await loadFullSectionText(this.session, sectionIndex);

    const segs = segmentSectionSafe(sectionIndex, sectionText, {
      bookLang: this.session.meta.language,
      ...(segOpts?.startOffset !== undefined ? { startOffset: segOpts.startOffset } : {}),
      ...(segOpts?.splitFirstLongUtterance !== undefined
        ? { splitFirstLongUtterance: segOpts.splitFirstLongUtterance }
        : {}),
    });

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
  private async stockAheadUntilHorizon(fromIndex: number, minAhead: number): Promise<Utterance[]> {
    const newlyAdded: Utterance[] = [];
    while (this.utterances.length - fromIndex < minAhead) {
      const nextSec = this.findNextLinearSection(this.highestQueuedSection);
      if (nextSec === null) break;
      const chunk = await this.loadAndAppendSection(nextSec);
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
