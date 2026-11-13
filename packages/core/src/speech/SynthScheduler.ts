import { MiniBookError } from '../errors.js';
import type { AttachedAudio, SynthRequest, SynthResult, Utterance } from '../types.js';
import { containsCjkCharacters } from './lang.js';

export interface SynthSchedulerConfig {
  readonly engine: 'edge' | 'openai';
  readonly voiceId: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly maxConcurrency?: number;
}

export interface SynthSchedulerOptions {
  readonly synthesize: (req: SynthRequest, signal: AbortSignal) => Promise<SynthResult>;
  readonly attachAudio: (id: string, audio: AttachedAudio) => void;
  readonly onEngineSlow?: (info: { readonly rtf: number; readonly engine: 'edge' | 'openai' }) => void;
  readonly onUtteranceFailed?: (id: string, error: MiniBookError) => void;
  readonly isHidden?: () => boolean;
  readonly now?: () => number;
}

type UtteranceFetchState = 'idle' | 'fetching' | 'ready' | 'failed';

interface TrackedUtterance {
  utterance: Utterance;
  state: UtteranceFetchState;
  durationMs: number;
  attempts: number;
  controller: AbortController | null;
}

const TARGET_AHEAD_VISIBLE_MS = 30_000; // 30 s (`ARCHITECTURE.md` §8.4)
const TARGET_AHEAD_HIDDEN_MS = 120_000; // 120 s (`ARCHITECTURE.md` §8.4)
const RETRY_DELAY_VISIBLE_MS = 250;
const RTF_EMA_WINDOW = 8;

function estimateFallbackDurationMs(u: Utterance): number {
  const cps = containsCjkCharacters(u.text) ? 5.5 : 14;
  return Math.max(400, Math.round((u.text.length / cps) * 1000) + u.pauseAfterMs);
}

/**
 * Event-driven lookahead TTS synthesis scheduler (`ARCHITECTURE.md` §8.4):
 *   - Generation counter `g` aborts all in-flight requests on voice change / seek / stop.
 *   - First unready utterance at play head is fetched ALONE at top priority (minimizes TTFA).
 *   - Automatically drops `effectiveConcurrency` from `2 -> 1` when overlapping requests show
 *     single-flight lock serialization (`secondElapsed >= ~sum of solo times`).
 *   - Tracks 8-sample EMA of `synthMs / durationMs` and emits `onEngineSlow` when
 *     `rtf / effectiveConcurrency >= 0.9`.
 *   - Uses **ZERO JS timers** (`setTimeout`) while `isHidden() === true` (retries run via `queueMicrotask`).
 */
export class SynthScheduler {
  private readonly opts: SynthSchedulerOptions;
  private config: SynthSchedulerConfig | null = null;
  private effectiveConcurrency = 2;
  private generation = 0;
  private disposed = false;

  private orderedIds: string[] = [];
  private items = new Map<string, TrackedUtterance>();
  private currentId: string | null = null;
  private inFlightCount = 0;

  // RTF & single-flight telemetry
  private rtfEma: number | null = null;
  private rtfSampleCount = 0;
  private slowSignalled = false;
  private soloMsPerChar: number | null = null;
  private activeStarts = new Map<string, { startedAt: number; overlappedWithOther: boolean }>();

  // Visible-only retry timers (flushed immediately if document becomes hidden!)
  private retryTimers = new Map<string, { timerId: ReturnType<typeof setTimeout>; run: () => void }>();

  constructor(options: SynthSchedulerOptions) {
    this.opts = options;
  }

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private hidden(): boolean {
    return this.opts.isHidden ? this.opts.isHidden() : false;
  }

  configure(config: SynthSchedulerConfig | null): void {
    this.abortAll();
    this.config = config;
    this.rtfEma = null;
    this.rtfSampleCount = 0;
    this.slowSignalled = false;
    this.soloMsPerChar = null;
    this.effectiveConcurrency = Math.max(1, config?.maxConcurrency ?? 2);

    // Reset all tracked utterances back to `'idle'` for the new voice
    for (const item of this.items.values()) {
      item.state = 'idle';
      item.attempts = 0;
      item.controller = null;
    }
    this.pump();
  }

  setQueue(utterances: readonly Utterance[], currentId: string | null): void {
    const newIds = utterances.map((u) => u.id);
    const newIdSet = new Set(newIds);

    // Detect non-contiguous seek: if `currentId` changed to an utterance that wasn't already ready/fetching next
    const prevIdx = this.currentId ? this.orderedIds.indexOf(this.currentId) : -1;
    const nextIdx = currentId ? newIds.indexOf(currentId) : -1;
    const jumpedFar =
      this.currentId !== null &&
      currentId !== null &&
      this.currentId !== currentId &&
      (prevIdx < 0 || nextIdx < 0 || Math.abs(nextIdx - prevIdx) > 2);

    if (jumpedFar) {
      this.abortInFlightOnly();
    }

    // Abort & prune items dropped from the queue
    for (const [id, tracked] of this.items.entries()) {
      if (!newIdSet.has(id)) {
        if (tracked.controller) tracked.controller.abort();
        this.cancelRetryTimer(id);
        this.items.delete(id);
      }
    }

    for (const u of utterances) {
      const existing = this.items.get(u.id);
      if (existing) {
        existing.utterance = u;
      } else {
        this.items.set(u.id, {
          utterance: u,
          state: 'idle',
          durationMs: estimateFallbackDurationMs(u),
          attempts: 0,
          controller: null,
        });
      }
    }

    this.orderedIds = newIds;
    this.currentId = currentId ?? newIds[0] ?? null;
    this.pump();
  }

  onUtteranceStart(id: string): void {
    this.currentId = id;
    this.pump();
  }

  onVisibilityChange(hidden: boolean): void {
    if (hidden && this.retryTimers.size > 0) {
      // Flush any pending visible-mode 250ms retry timers immediately without waiting for throttled timers!
      const pending = [...this.retryTimers.values()];
      this.retryTimers.clear();
      for (const entry of pending) {
        clearTimeout(entry.timerId);
        queueMicrotask(entry.run);
      }
    }
    this.pump();
  }

  abortAll(): void {
    this.generation++;
    this.abortInFlightOnly();
  }

  getRtf(): number | null {
    return this.rtfEma;
  }

  getEffectiveConcurrency(): number {
    return this.effectiveConcurrency;
  }

  dispose(): void {
    this.disposed = true;
    this.abortAll();
    this.items.clear();
    this.orderedIds = [];
  }

  private abortInFlightOnly(): void {
    this.generation++;
    for (const tracked of this.items.values()) {
      if (tracked.controller) {
        tracked.controller.abort();
        tracked.controller = null;
      }
      if (tracked.state === 'fetching') {
        tracked.state = 'idle';
      }
    }
    for (const entry of this.retryTimers.values()) {
      clearTimeout(entry.timerId);
    }
    this.retryTimers.clear();
    this.activeStarts.clear();
    this.inFlightCount = 0;
  }

  private cancelRetryTimer(id: string): void {
    const t = this.retryTimers.get(id);
    if (t) {
      clearTimeout(t.timerId);
      this.retryTimers.delete(id);
    }
  }

  private computeAheadReadyMs(startIndex: number): number {
    let ahead = 0;
    for (let i = startIndex; i < this.orderedIds.length; i++) {
      const item = this.items.get(this.orderedIds[i]!);
      if (!item) break;
      if (item.state === 'ready') {
        ahead += item.durationMs;
      } else if (item.state === 'failed') {
        // Failed items will be spoken by system fallback; keep counting subsequent ready items
        continue;
      } else {
        // Stop counting contiguous ready buffer at the first unready gap (or include fetching estimate? Spec §8.4:
        // "ahead = sum duration of consecutive `ready` utterances after the play head")
        break;
      }
    }
    return ahead;
  }

  private pump(): void {
    if (this.disposed || !this.config || this.orderedIds.length === 0) return;

    const startIdx = Math.max(
      0,
      this.currentId ? this.orderedIds.indexOf(this.currentId) : 0,
    );
    const targetAheadMs = this.hidden() ? TARGET_AHEAD_HIDDEN_MS : TARGET_AHEAD_VISIBLE_MS;

    while (this.inFlightCount < this.effectiveConcurrency) {
      const headItem = this.items.get(this.orderedIds[startIdx]!);
      // First-utterance priority rule (`ARCHITECTURE.md` §8.4):
      // While the play-head utterance itself is still `fetching`, do NOT launch a second request behind it!
      if (headItem && headItem.state === 'fetching' && this.inFlightCount >= 1) {
        break;
      }

      const aheadMs = this.computeAheadReadyMs(startIdx);
      if (aheadMs >= targetAheadMs) {
        break;
      }

      // Pick next `'idle'` utterance in play order starting at `startIdx`
      let nextTracked: TrackedUtterance | null = null;
      for (let i = startIdx; i < this.orderedIds.length; i++) {
        const cand = this.items.get(this.orderedIds[i]!);
        if (cand && cand.state === 'idle' && !this.retryTimers.has(cand.utterance.id)) {
          nextTracked = cand;
          break;
        }
      }

      if (!nextTracked) break;
      this.startFetch(nextTracked);

      // If we just started the play-head utterance itself (`idle -> fetching`), fetch it ALONE first!
      if (nextTracked === headItem) {
        break;
      }
    }
  }

  private startFetch(tracked: TrackedUtterance): void {
    if (!this.config) return;
    const cfg = this.config;
    const gen = this.generation;
    const u = tracked.utterance;
    const controller = new AbortController();

    tracked.state = 'fetching';
    tracked.controller = controller;
    const overlapped = this.inFlightCount > 0;
    // Also mark any already-running request as having overlapped
    for (const existing of this.activeStarts.values()) {
      existing.overlappedWithOther = true;
    }
    const startedAt = this.nowMs();
    this.activeStarts.set(u.id, { startedAt, overlappedWithOther: overlapped });
    this.inFlightCount++;

    const req: SynthRequest = {
      engine: cfg.engine,
      voiceId: cfg.voiceId,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
      text: u.text,
      lang: u.lang,
    };

    this.opts.synthesize(req, controller.signal).then(
      (res) => {
        if (this.disposed || gen !== this.generation) return;
        const startMeta = this.activeStarts.get(u.id);
        this.activeStarts.delete(u.id);
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        tracked.controller = null;
        tracked.state = 'ready';

        const durationMs =
          res.durationMs && res.durationMs > 0
            ? res.durationMs
            : estimateFallbackDurationMs(u);
        tracked.durationMs = durationMs;

        const wallElapsedMs = Math.max(
          0,
          res.synthMs > 0 ? res.synthMs : this.nowMs() - (startMeta?.startedAt ?? startedAt),
        );

        // Update single-flight lock detector & RTF meter (skip cached disk hits so cache hits don't skew RTF!)
        if (!res.cached) {
          this.recordTelemetry(u, wallElapsedMs, durationMs, Boolean(startMeta?.overlappedWithOther), cfg.engine);
        }

        this.opts.attachAudio(u.id, {
          ref: res.ref,
          durationMs,
          ...(res.marks ? { marks: res.marks } : {}),
        });

        this.pump();
      },
      (rawErr: unknown) => {
        if (this.disposed || gen !== this.generation) return;
        this.activeStarts.delete(u.id);
        this.inFlightCount = Math.max(0, this.inFlightCount - 1);
        tracked.controller = null;

        const err = MiniBookError.wrap(rawErr, 'speech-unavailable');
        if (err.code === 'cancelled' || controller.signal.aborted) {
          tracked.state = 'idle';
          return;
        }

        tracked.attempts++;
        // Retry once (except on explicit 401/403 `speech-auth`)
        if (tracked.attempts <= 1 && err.code !== 'speech-auth') {
          tracked.state = 'idle';
          const retryFn = () => {
            this.retryTimers.delete(u.id);
            if (this.disposed || gen !== this.generation) return;
            this.pump();
          };
          if (this.hidden()) {
            // ZERO JS timers when hidden (`ARCHITECTURE.md` §8.4)!
            queueMicrotask(retryFn);
          } else {
            const timerId = setTimeout(retryFn, RETRY_DELAY_VISIBLE_MS);
            this.retryTimers.set(u.id, { timerId, run: retryFn });
          }
          return;
        }

        tracked.state = 'failed';
        this.opts.onUtteranceFailed?.(u.id, err);
        this.pump();
      },
    );
  }

  private recordTelemetry(
    u: Utterance,
    synthMs: number,
    durationMs: number,
    overlapped: boolean,
    engine: 'edge' | 'openai',
  ): void {
    const charLen = Math.max(1, u.text.length);
    const msPerChar = synthMs / charLen;

    if (!overlapped) {
      this.soloMsPerChar =
        this.soloMsPerChar === null ? msPerChar : this.soloMsPerChar * 0.7 + msPerChar * 0.3;
    } else if (this.effectiveConcurrency > 1 && this.soloMsPerChar !== null && this.soloMsPerChar > 0) {
      // Single-flight server lock detection (`§8.4`):
      // When two overlapping requests serialize behind a lock, the queued request takes ~2x solo rate!
      const expectedSoloMs = this.soloMsPerChar * charLen;
      if (expectedSoloMs >= 40 && synthMs >= expectedSoloMs * 1.65) {
        this.effectiveConcurrency = 1;
      }
    }

    const sampleRtf = synthMs / Math.max(100, durationMs);
    this.rtfSampleCount++;
    const alpha = 2 / (RTF_EMA_WINDOW + 1);
    this.rtfEma =
      this.rtfEma === null
        ? sampleRtf
        : this.rtfEma * (1 - alpha) + sampleRtf * alpha;

    if (
      !this.slowSignalled &&
      this.rtfSampleCount >= 2 &&
      this.rtfEma / this.effectiveConcurrency >= 0.9
    ) {
      this.slowSignalled = true;
      this.opts.onEngineSlow?.({ rtf: this.rtfEma, engine });
    }
  }
}
