/**
 * Browser-side Kokoro-82M engine manager for `RestPlatformHost` (`TTS_V2_SPEC.md` §5.1):
 *   - Lazily spawns `kokoro.worker.ts` on first synthesis
 *   - Serializes synthesis jobs (`maxConcurrency = 1`); aborted jobs drop cleanly by request id
 *   - Terminates worker after 10 min idle or on `dispose()` / `models.remove()`
 *   - Tracks 8-sample RTF EMA and reports backend / RTF telemetry
 */
import {
  MiniBookError,
  type KokoroWordSpan,
  type SpeechModelBackend,
  type WordMark,
} from '@minibook/core';
import type { KokoroWorkerRequest, KokoroWorkerResponse } from './kokoro.worker.js';

const IDLE_TERMINATE_MS = 10 * 60 * 1000;
const RTF_EMA_WINDOW = 8;

export interface KokoroWebSynthInput {
  readonly voiceId: string;
  readonly variant?: 'onnx-fp32' | 'onnx-q8';
  readonly text: string;
  readonly phonemeIds: readonly (readonly number[])[];
  readonly phonemeSpeeds?: readonly number[];
  readonly phonemeSpans?: readonly (readonly KokoroWordSpan[])[];
}

export interface KokoroWebSynthOutput {
  readonly wav: Uint8Array;
  readonly durationMs: number;
  readonly marks: readonly WordMark[];
  readonly synthMs: number;
  readonly backend: SpeechModelBackend;
  readonly rtf: number;
}

export interface KokoroWorkerLike {
  postMessage(msg: KokoroWorkerRequest): void;
  addEventListener(type: 'message', fn: (ev: MessageEvent<KokoroWorkerResponse>) => void): void;
  addEventListener(type: 'error', fn: (ev: ErrorEvent) => void): void;
  terminate(): void;
}

export interface KokoroWebEngineOptions {
  readonly baseUrl?: string;
  readonly idleTimeoutMs?: number;
  readonly workerFactory?: () => KokoroWorkerLike;
  readonly onTelemetry?: (info: {
    readonly backend: SpeechModelBackend;
    readonly rtf?: number;
  }) => void;
  readonly onSelfTestError?: (err: MiniBookError) => void;
}

export class KokoroWebEngine {
  private readonly baseUrl: string;
  private readonly idleTimeoutMs: number;
  private readonly hasCustomWorkerFactory: boolean;
  private readonly workerFactory: () => KokoroWorkerLike;
  private readonly onTelemetry:
    | ((info: { readonly backend: SpeechModelBackend; readonly rtf?: number }) => void)
    | undefined;
  private readonly onSelfTestError: ((err: MiniBookError) => void) | undefined;

  private worker: KokoroWorkerLike | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReqId = 1;
  private tail: Promise<void> = Promise.resolve();
  private rtfEma: number | null = null;
  private lastBackend: SpeechModelBackend | null = null;

  private pending = new Map<
    number,
    {
      readonly resolve: (res: KokoroWorkerResponse) => void;
      readonly reject: (err: Error) => void;
    }
  >();

  constructor(options?: KokoroWebEngineOptions) {
    this.baseUrl = options?.baseUrl ?? '';
    this.idleTimeoutMs = options?.idleTimeoutMs ?? IDLE_TERMINATE_MS;
    this.hasCustomWorkerFactory = Boolean(options?.workerFactory);
    this.workerFactory =
      options?.workerFactory ??
      (() => new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' }));
    this.onTelemetry = options?.onTelemetry;
    this.onSelfTestError = options?.onSelfTestError;
  }

  getBackend(): SpeechModelBackend | null {
    return this.lastBackend;
  }

  getRtf(): number | null {
    return this.rtfEma;
  }

  private ensureWorker(): KokoroWorkerLike {
    if (this.worker) return this.worker;
    if (!this.hasCustomWorkerFactory && typeof Worker === 'undefined') {
      throw new MiniBookError('unsupported', 'Web Workers are not available in this environment');
    }
    const w = this.workerFactory();
    w.addEventListener('message', (ev) => {
      const msg = ev.data;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      entry.resolve(msg);
    });
    w.addEventListener('error', (ev) => {
      const err = new MiniBookError(
        'speech-unavailable',
        ev.message || 'Kokoro Web Worker crashed',
      );
      this.failAllPending(err);
      this.terminateWorker();
    });
    this.worker = w;
    return w;
  }

  private failAllPending(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.reject(err);
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) {
        this.terminateWorker();
      }
    }, this.idleTimeoutMs);
  }

  private terminateWorker(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }

  dispose(): void {
    this.failAllPending(new MiniBookError('cancelled', 'Kokoro engine disposed'));
    this.terminateWorker();
    this.rtfEma = null;
    this.lastBackend = null;
  }

  synthesize(input: KokoroWebSynthInput, signal?: AbortSignal): Promise<KokoroWebSynthOutput> {
    if (signal?.aborted) {
      return Promise.reject(new MiniBookError('cancelled', 'Kokoro synthesis aborted'));
    }

    const run = this.tail.then(() => this.runSerialized(input, signal));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSerialized(
    input: KokoroWebSynthInput,
    signal?: AbortSignal,
  ): Promise<KokoroWebSynthOutput> {
    if (signal?.aborted) {
      throw new MiniBookError('cancelled', 'Kokoro synthesis aborted');
    }

    const worker = this.ensureWorker();
    const id = this.nextReqId++;

    const response = await new Promise<KokoroWorkerResponse>((resolvePromise, rejectPromise) => {
      const onAbort = () => {
        // Worker inference is not interrupted mid-run; drop its result cleanly (`TTS_V2_SPEC.md` §5.1)
        this.pending.delete(id);
        rejectPromise(new MiniBookError('cancelled', 'Kokoro synthesis cancelled'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, {
        resolve: (res) => {
          signal?.removeEventListener('abort', onAbort);
          resolvePromise(res);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          rejectPromise(err);
        },
      });

      worker.postMessage({
        type: 'synth',
        id,
        baseUrl: this.baseUrl,
        ...(input.variant !== undefined ? { variant: input.variant } : {}),
        voiceId: input.voiceId,
        text: input.text,
        phonemeIds: input.phonemeIds,
        ...(input.phonemeSpeeds !== undefined ? { phonemeSpeeds: input.phonemeSpeeds } : {}),
        ...(input.phonemeSpans !== undefined ? { phonemeSpans: input.phonemeSpans } : {}),
      });
    });

    this.resetIdleTimer();

    if (response.type === 'error') {
      const err = new MiniBookError(response.code, response.message);
      if (response.code === 'model-selftest') {
        this.onSelfTestError?.(err);
        this.terminateWorker();
      }
      throw err;
    }

    if (response.type !== 'synth-ok') {
      throw new MiniBookError('speech-unavailable', 'Unexpected response from Kokoro worker');
    }

    const sampleRtf = response.synthMs / Math.max(100, response.durationMs);
    const alpha = 2 / (RTF_EMA_WINDOW + 1);
    this.rtfEma =
      this.rtfEma === null ? sampleRtf : this.rtfEma * (1 - alpha) + sampleRtf * alpha;
    this.lastBackend = response.backend;
    this.onTelemetry?.({ backend: response.backend, rtf: this.rtfEma });

    return {
      wav: new Uint8Array(response.wav),
      durationMs: response.durationMs,
      marks: response.marks,
      synthMs: response.synthMs,
      backend: response.backend,
      rtf: this.rtfEma,
    };
  }
}
