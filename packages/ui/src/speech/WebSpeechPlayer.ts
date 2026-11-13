import type {
  AttachedAudio,
  SleepTimerConfig,
  SpeechEvent,
  SpeechPlayer,
  SpeechSession,
  SpeechState,
  Unsubscribe,
  Utterance,
  Voice,
  VoiceRef,
} from '@minibook/core';

export interface WebSpeechPlayerOptions {
  readonly bufferingTimeoutOnlineMs?: number;
  readonly bufferingTimeoutOfflineMs?: number;
}

/**
 * Browser `SpeechPlayer` implementation (`ARCHITECTURE.md` §8.3, §8.5):
 * - Speaks system voices sentence-by-sentence via `window.speechSynthesis` (with `boundary` word events).
 * - Plays synthesized audio via two pooled `<audio>` elements (`preservesPitch = true`).
 * - Implements the 8s (2s offline) paragraph-sticky system-voice fallback (`§8.5`).
 * - Syncs OS media keys & metadata via `navigator.mediaSession`.
 */
export class WebSpeechPlayer implements SpeechPlayer {
  readonly capabilities = {
    nativeQueue: false,
    wordEvents: true,
  } as const;

  private readonly onlineTimeoutMs: number;
  private readonly offlineTimeoutMs: number;
  private readonly listeners = new Set<(e: SpeechEvent) => void>();

  private session: SpeechSession | null = null;
  private queue: Utterance[] = [];
  private attached = new Map<string, AttachedAudio>();
  private currentIdx = 0;
  private status: SpeechState['status'] = 'idle';
  private rate = 1.0;
  private voice: VoiceRef | null = null;
  private stickyFallbackBlock: { section: number; blockIndex: number } | null = null;

  private sleepConfig: SleepTimerConfig = { mode: 'off' };
  private sleepDeadlineMs: number | null = null;
  private stopAfterCurrent = false;
  private sleepTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private gapTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private bufferingTimerHandle: ReturnType<typeof setTimeout> | null = null;
  private markTickerHandle: ReturnType<typeof setInterval> | null = null;
  private playGeneration = 0;
  private queueLowEmitted = false;

  private audioPool: [HTMLAudioElement, HTMLAudioElement] | null = null;
  private activeAudioIdx: 0 | 1 = 0;

  constructor(options?: WebSpeechPlayerOptions) {
    this.onlineTimeoutMs = options?.bufferingTimeoutOnlineMs ?? 8000;
    this.offlineTimeoutMs = options?.bufferingTimeoutOfflineMs ?? 2000;
  }

  private getAudioPool(): [HTMLAudioElement, HTMLAudioElement] | null {
    if (this.audioPool) return this.audioPool;
    if (typeof Audio === 'undefined') return null;
    const a0 = new Audio();
    const a1 = new Audio();
    a0.preload = 'auto';
    a1.preload = 'auto';
    this.audioPool = [a0, a1];
    return this.audioPool;
  }

  async listVoices(): Promise<Voice[]> {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return [];
    }
    const synth = window.speechSynthesis;
    let raw = synth.getVoices();
    if (raw.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        synth.addEventListener(
          'voiceschanged',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      raw = synth.getVoices();
    }
    return raw.map((v) => ({
      id: v.voiceURI || v.name,
      engine: 'System',
      provider: 'system',
      name: v.name,
      lang: v.lang,
      quality: v.localService ? 'enhanced' : 'remote',
      local: v.localService,
    }));
  }

  async load(session: SpeechSession): Promise<void> {
    this.cancelActiveOutput();
    this.clearSleepTimer();
    this.session = session;
    this.queue = [];
    this.attached.clear();
    this.currentIdx = 0;
    this.status = 'idle';
    this.rate = session.rate;
    this.voice = session.voice;
    this.stickyFallbackBlock = null;
    this.stopAfterCurrent = false;
    this.syncMediaSession();
    this.emitState();
  }

  enqueue(items: readonly Utterance[], opts?: { readonly replaceFromId?: string }): void {
    if (opts?.replaceFromId) {
      const idx = this.queue.findIndex((u) => u.id === opts.replaceFromId);
      if (idx >= 0) {
        this.queue = [...this.queue.slice(0, idx), ...items];
        return;
      }
    }
    const seen = new Set(this.queue.map((u) => u.id));
    for (const u of items) {
      if (!seen.has(u.id)) {
        this.queue.push(u);
        seen.add(u.id);
      }
    }
    if (this.queue.length - this.currentIdx > 20) {
      this.queueLowEmitted = false;
    }
  }

  attachAudio(id: string, audio: AttachedAudio): void {
    this.attached.set(id, audio);
    const cur = this.queue[this.currentIdx];
    if (this.status === 'buffering' && cur && cur.id === id) {
      this.clearBufferingTimer();
      this.speakCurrent();
    }
  }

  play(): void {
    if (!this.session || this.queue.length === 0) return;
    if (this.status === 'playing') return;
    this.status = 'playing';
    this.syncMediaSession();
    this.emitState();
    this.speakCurrent();
  }

  pause(): void {
    if (this.status !== 'playing' && this.status !== 'buffering') return;
    this.cancelActiveOutput();
    this.status = 'paused';
    this.syncMediaSession();
    this.emitState();
  }

  stop(): void {
    this.cancelActiveOutput();
    this.clearSleepTimer();
    this.status = 'idle';
    this.queue = [];
    this.attached.clear();
    this.currentIdx = 0;
    this.stickyFallbackBlock = null;
    this.syncMediaSession();
    this.emit({ type: 'speech-ended', reason: 'stopped' });
    this.emitState();
  }

  seekTo(id: string): void {
    const idx = this.queue.findIndex((u) => u.id === id);
    if (idx < 0) return;
    const wasActive = this.status === 'playing' || this.status === 'buffering';
    this.cancelActiveOutput();
    this.currentIdx = idx;
    this.stickyFallbackBlock = null;
    if (wasActive) {
      this.status = 'playing';
      this.speakCurrent();
    } else {
      this.emitState();
    }
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.5, Math.min(3.0, Math.round(rate * 10) / 10));
    const pool = this.audioPool;
    if (pool) {
      for (const el of pool) {
        el.playbackRate = this.rate;
      }
    }
    this.emitState();
  }

  setVoice(voice: VoiceRef): void {
    const wasActive = this.status === 'playing' || this.status === 'buffering';
    this.cancelActiveOutput();
    this.voice = voice;
    this.stickyFallbackBlock = null;
    this.emitState();
    if (wasActive) {
      this.status = 'playing';
      this.speakCurrent();
    }
  }

  setSleepTimer(timer: SleepTimerConfig): void {
    this.clearSleepTimer();
    this.sleepConfig = timer;
    this.stopAfterCurrent = false;

    if (timer.mode === 'minutes' && timer.minutes && timer.minutes > 0) {
      const ms = timer.minutes * 60_000;
      this.sleepDeadlineMs = Date.now() + ms;
      this.sleepTimerHandle = setTimeout(() => {
        this.sleepTimerHandle = null;
        this.stopAfterCurrent = true;
      }, ms);
    }

    this.emit({
      type: 'sleep-timer',
      mode: timer.mode,
      ...(timer.minutes !== undefined ? { remainingMs: timer.minutes * 60_000 } : {}),
    });
    this.emitState();
  }

  async getState(): Promise<SpeechState> {
    return this.snapshotState();
  }

  subscribe(listener: (event: SpeechEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private isStickyFallbackFor(u: Utterance): boolean {
    if (!this.stickyFallbackBlock) return false;
    if (
      this.stickyFallbackBlock.section === u.section &&
      this.stickyFallbackBlock.blockIndex === u.blockIndex
    ) {
      return true;
    }
    // Paragraph ended: return to primary synth voice if ready (`ARCHITECTURE.md` §8.5)
    this.stickyFallbackBlock = null;
    return false;
  }

  private speakCurrent(): void {
    const u = this.queue[this.currentIdx];
    if (!u || !this.session) {
      this.status = 'ended-of-buffer';
      this.emit({ type: 'speech-ended', reason: 'end-of-buffer' });
      this.emitState();
      return;
    }

    const gen = ++this.playGeneration;
    const activeVoice = this.voice ?? { kind: 'system', voiceId: null };
    const useFallbackNow = this.isStickyFallbackFor(u);

    if (activeVoice.kind === 'system' || useFallbackNow) {
      this.status = 'playing';
      this.emitState();
      this.emit({
        type: 'utterance-start',
        id: u.id,
        section: u.section,
        start: u.start,
        end: u.end,
        usingFallback: useFallbackNow,
      });
      this.speakViaSystemSynthesis(u, useFallbackNow ? this.session.systemFallback?.voiceId ?? null : activeVoice.voiceId, gen);
      return;
    }

    const attached = this.attached.get(u.id);
    if (attached) {
      this.status = 'playing';
      this.emitState();
      this.emit({
        type: 'utterance-start',
        id: u.id,
        section: u.section,
        start: u.start,
        end: u.end,
        usingFallback: false,
      });
      this.playAttachedAudio(u, attached, gen);
      return;
    }

    // Audio not yet attached -> enter buffering (`ARCHITECTURE.md` §8.5)
    // `kokoro` is a local on-device engine, so `navigator.onLine === false` does not shorten its wait window.
    this.status = 'buffering';
    this.emitState();
    const isLocalEngine = activeVoice.kind === 'kokoro';
    const isOffline = !isLocalEngine && typeof navigator !== 'undefined' && navigator.onLine === false;
    const waitMs = isOffline ? this.offlineTimeoutMs : this.onlineTimeoutMs;

    this.clearBufferingTimer();
    this.bufferingTimerHandle = setTimeout(() => {
      this.bufferingTimerHandle = null;
      if (gen !== this.playGeneration || this.status !== 'buffering') return;
      if (this.session?.systemFallback) {
        this.stickyFallbackBlock = { section: u.section, blockIndex: u.blockIndex };
        this.emit({ type: 'speech-fallback', reason: isOffline ? 'offline' : 'timeout', utteranceId: u.id });
        this.speakCurrent();
      }
    }, waitMs);
  }

  private speakViaSystemSynthesis(u: Utterance, preferredVoiceId: string | null, gen: number): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      // Headless / jsdom fallback timer
      const approxMs = Math.max(80, Math.round((u.text.length * 45) / this.rate));
      this.gapTimerHandle = setTimeout(() => {
        if (gen !== this.playGeneration) return;
        this.onUtteranceFinished(u, gen);
      }, approxMs);
      return;
    }

    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new SpeechSynthesisUtterance(u.text);
    utter.lang = u.lang;
    utter.rate = this.rate;

    if (preferredVoiceId) {
      const match = synth.getVoices().find((v) => v.voiceURI === preferredVoiceId || v.name === preferredVoiceId);
      if (match) utter.voice = match;
    }

    utter.onboundary = (ev: SpeechSynthesisEvent) => {
      if (gen !== this.playGeneration) return;
      if (ev.name && ev.name !== 'word') return;
      const start = Math.max(0, Math.min(u.text.length, ev.charIndex));
      const len = ev.charLength && ev.charLength > 0 ? ev.charLength : this.measureWordLen(u.text, start);
      this.emit({
        type: 'utterance-word',
        id: u.id,
        start,
        end: Math.min(u.text.length, start + len),
      });
    };

    utter.onend = () => {
      if (gen !== this.playGeneration) return;
      this.onUtteranceFinished(u, gen);
    };

    utter.onerror = () => {
      if (gen !== this.playGeneration) return;
      this.onUtteranceFinished(u, gen);
    };

    synth.speak(utter);
  }

  private playAttachedAudio(u: Utterance, attached: AttachedAudio, gen: number): void {
    const pool = this.getAudioPool();
    if (!pool) {
      this.onUtteranceFinished(u, gen);
      return;
    }

    const audio = pool[this.activeAudioIdx];
    this.activeAudioIdx = this.activeAudioIdx === 0 ? 1 : 0;

    audio.src = attached.ref;
    audio.playbackRate = this.rate;
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;

    let lastMarkIdx = -1;
    if (attached.marks && attached.marks.length > 0) {
      const marks = attached.marks;
      this.markTickerHandle = setInterval(() => {
        if (gen !== this.playGeneration) return;
        const tMs = audio.currentTime * 1000;
        for (let i = lastMarkIdx + 1; i < marks.length; i++) {
          const m = marks[i]!;
          if (tMs >= m.timeMs) {
            lastMarkIdx = i;
            this.emit({
              type: 'utterance-word',
              id: u.id,
              start: m.start,
              end: m.end,
              timeMs: m.timeMs,
            });
          } else {
            break;
          }
        }
      }, 60);
    }

    audio.onended = () => {
      if (gen !== this.playGeneration) return;
      this.clearMarkTicker();
      this.onUtteranceFinished(u, gen);
    };

    audio.onerror = () => {
      if (gen !== this.playGeneration) return;
      this.clearMarkTicker();
      if (this.session?.systemFallback) {
        this.stickyFallbackBlock = { section: u.section, blockIndex: u.blockIndex };
        this.emit({ type: 'speech-fallback', reason: 'audio-error', utteranceId: u.id });
        this.speakCurrent();
      } else {
        this.onUtteranceFinished(u, gen);
      }
    };

    void audio.play().catch(() => {
      if (gen !== this.playGeneration) return;
      this.clearMarkTicker();
      this.onUtteranceFinished(u, gen);
    });
  }

  private onUtteranceFinished(u: Utterance, gen: number): void {
    this.emit({ type: 'utterance-done', id: u.id });

    const nextU = this.queue[this.currentIdx + 1];
    const sectionEnded = !nextU || nextU.section !== u.section;
    if (this.stopAfterCurrent || (this.sleepConfig.mode === 'endOfSection' && sectionEnded)) {
      this.stopAfterCurrent = false;
      this.clearSleepTimer();
      this.sleepConfig = { mode: 'off' };
      this.status = 'paused';
      if (nextU) this.currentIdx += 1;
      this.emit({ type: 'sleep-timer', mode: 'off', expired: true });
      this.emit({ type: 'speech-ended', reason: 'sleep-timer' });
      this.syncMediaSession();
      this.emitState();
      return;
    }

    if (!nextU) {
      this.status = 'ended-of-buffer';
      this.emit({ type: 'speech-ended', reason: 'completed' });
      this.syncMediaSession();
      this.emitState();
      return;
    }

    // Advance currentIdx immediately after utterance-done so pausing during the inter-sentence
    // silence gap resumes on the NEXT sentence instead of repeating the finished one.
    this.currentIdx += 1;
    const remaining = this.queue.length - this.currentIdx;
    if (remaining <= 20 && !this.queueLowEmitted) {
      this.queueLowEmitted = true;
      this.emit({ type: 'queue-low', remaining });
    }

    const pauseMs = Math.max(0, Math.round(u.pauseAfterMs / Math.max(0.5, this.rate)));
    this.gapTimerHandle = setTimeout(() => {
      this.gapTimerHandle = null;
      if (gen !== this.playGeneration || this.status !== 'playing') return;
      this.speakCurrent();
    }, pauseMs);
  }

  private measureWordLen(text: string, start: number): number {
    let end = start;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    return Math.max(1, end - start);
  }

  private syncMediaSession(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
      return;
    }
    const ms = navigator.mediaSession;
    if (!this.session || this.status === 'idle') {
      ms.playbackState = 'none';
      return;
    }

    if (typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({
        title: this.session.chapterTitle || this.session.title,
        artist: this.session.title,
        album: this.session.author,
        artwork: this.session.coverUrl ? [{ src: this.session.coverUrl }] : [],
      });
    }

    // Keep playbackState 'playing' across pauses/buffering per ARCHITECTURE.md §8.3
    ms.playbackState = this.status === 'paused' ? 'paused' : 'playing';

    try {
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('previoustrack', () => {
        const target = this.queue[Math.max(0, this.currentIdx - 1)];
        if (target) this.seekTo(target.id);
      });
      ms.setActionHandler('nexttrack', () => {
        const target = this.queue[Math.min(this.queue.length - 1, this.currentIdx + 1)];
        if (target) this.seekTo(target.id);
      });
    } catch {
      // Unsupported mediaSession action in some WebViews
    }
  }

  private cancelActiveOutput(): void {
    this.playGeneration += 1;
    this.clearBufferingTimer();
    this.clearMarkTicker();
    if (this.gapTimerHandle !== null) {
      clearTimeout(this.gapTimerHandle);
      this.gapTimerHandle = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    if (this.audioPool) {
      for (const el of this.audioPool) {
        try {
          el.pause();
          el.removeAttribute('src');
        } catch {
          // ignore
        }
      }
    }
  }

  private clearBufferingTimer(): void {
    if (this.bufferingTimerHandle !== null) {
      clearTimeout(this.bufferingTimerHandle);
      this.bufferingTimerHandle = null;
    }
  }

  private clearMarkTicker(): void {
    if (this.markTickerHandle !== null) {
      clearInterval(this.markTickerHandle);
      this.markTickerHandle = null;
    }
  }

  private clearSleepTimer(): void {
    if (this.sleepTimerHandle !== null) {
      clearTimeout(this.sleepTimerHandle);
      this.sleepTimerHandle = null;
    }
    this.sleepDeadlineMs = null;
  }

  private snapshotState(): SpeechState {
    const cur = this.queue[this.currentIdx] ?? null;
    const remainingMs =
      this.sleepDeadlineMs !== null ? Math.max(0, this.sleepDeadlineMs - Date.now()) : undefined;
    return {
      status: this.status,
      bookId: this.session?.bookId ?? null,
      currentUtteranceId: cur?.id ?? null,
      section: cur?.section ?? null,
      offset: cur?.start ?? null,
      rate: this.rate,
      voice: this.voice,
      usingFallback: cur ? this.isStickyFallbackFor(cur) : false,
      sleepTimer: {
        mode: this.sleepConfig.mode,
        ...(remainingMs !== undefined ? { remainingMs } : {}),
      },
    };
  }

  private emitState(): void {
    this.emit({ type: 'speech-state', state: this.snapshotState() });
  }

  private emit(e: SpeechEvent): void {
    for (const l of this.listeners) l(e);
  }
}

export function createWebSpeechPlayer(options?: WebSpeechPlayerOptions): WebSpeechPlayer {
  return new WebSpeechPlayer(options);
}
