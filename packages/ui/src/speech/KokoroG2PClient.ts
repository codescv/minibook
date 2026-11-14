import {
  createKokoroG2P,
  type KokoroG2P,
  type KokoroG2PResult,
  type Utterance,
} from '@minibook/core';
import type { G2PWorkerRequest, G2PWorkerResponse } from './kokoro-g2p.worker';

export interface MinimalWorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<any>) => void) | null;
  onerror: ((event: any) => void) | null;
  addEventListener?: ((type: string, listener: (event: any) => void) => void) | undefined;
}

export interface KokoroG2PClientOptions {
  baseUrl?: string | undefined;
  loadAsset?: ((name: string) => Promise<Uint8Array>) | undefined;
  workerFactory?: (() => MinimalWorkerLike) | undefined;
  handshakeTimeoutMs?: number | undefined;
  forceMainThread?: boolean | undefined;
  timeSliceBatchSize?: number | undefined;
  maxCacheEntries?: number | undefined;
}

interface PendingJob {
  id: number;
  kind: 'phonemize' | 'preload';
  text?: string | undefined;
  lang?: string | undefined;
  voiceId?: string | undefined;
  includeEnglish?: boolean | undefined;
  resolve: (value: any) => void;
  reject: (err: unknown) => void;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2000;
const DEFAULT_TIMESLICE_BATCH = 20;
const DEFAULT_MAX_CACHE = 2048;

export class KokoroG2PClient {
  private readonly baseUrl: string;
  private readonly customLoadAsset?: ((name: string) => Promise<Uint8Array>) | undefined;
  private readonly workerFactory?: (() => MinimalWorkerLike) | undefined;
  private readonly handshakeTimeoutMs: number;
  private readonly timeSliceBatchSize: number;
  private readonly maxCacheEntries: number;

  private mode: 'uninitialized' | 'worker-connecting' | 'worker-ready' | 'main' = 'uninitialized';
  private worker: MinimalWorkerLike | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReqId = 1;
  private pending = new Map<number, PendingJob>();
  private queuedBeforeReady: PendingJob[] = [];

  private mainG2P: KokoroG2P | null = null;
  private mainSliceCounter = 0;
  private mainQueue: Promise<void> = Promise.resolve();

  private cache = new Map<string, KokoroG2PResult>();
  private disposed = false;

  constructor(options: KokoroG2PClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.customLoadAsset = options.loadAsset;
    this.workerFactory = options.workerFactory;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.timeSliceBatchSize = Math.max(1, options.timeSliceBatchSize ?? DEFAULT_TIMESLICE_BATCH);
    this.maxCacheEntries = Math.max(64, options.maxCacheEntries ?? DEFAULT_MAX_CACHE);

    if (options.forceMainThread) {
      this.mode = 'main';
    }
  }

  getExecutionMode(): 'uninitialized' | 'worker-connecting' | 'worker-ready' | 'main' {
    return this.mode;
  }

  private getMainG2P(): KokoroG2P {
    if (!this.mainG2P) {
      const loadAsset =
        this.customLoadAsset ??
        (async (name: string): Promise<Uint8Array> => {
          if (typeof fetch !== 'function') {
            throw new Error('fetch unavailable');
          }
          const prefix = this.baseUrl ? this.baseUrl.replace(/\/$/, '') : '';
          const res = await fetch(`${prefix}/kokoro-g2p/v1/${name}`);
          if (!res.ok) {
            throw new Error(`HTTP ${res.status} loading G2P asset ${name}`);
          }
          return new Uint8Array(await res.arrayBuffer());
        });
      this.mainG2P = createKokoroG2P({ loadAsset });
    }
    return this.mainG2P;
  }

  private ensureInitialized(): void {
    if (this.mode !== 'uninitialized') return;

    // In jsdom / Node without a custom workerFactory, when customLoadAsset is injected directly,
    // or on native Capacitor custom schemes (`capacitor://localhost` / `Capacitor.isNativePlatform()`,
    // where `new Worker(..., { type: 'module' })` stalls until handshakeTimeoutMs), run directly on
    // the main thread (`< 15 ms` per sentence batch, zero 2s stall).
    const isJsdom =
      typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent ?? '');
    const isCapacitorNative =
      typeof window !== 'undefined' &&
      (window.location?.protocol === 'capacitor:' ||
        Boolean(
          (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.(),
        ));
    if (
      !this.workerFactory &&
      (typeof Worker === 'undefined' || isJsdom || isCapacitorNative || this.customLoadAsset)
    ) {
      this.mode = 'main';
      return;
    }

    try {
      const w = this.workerFactory
        ? this.workerFactory()
        : (new Worker(new URL('./kokoro-g2p.worker.ts', import.meta.url), {
            type: 'module',
          }) as unknown as MinimalWorkerLike);

      this.worker = w;
      this.mode = 'worker-connecting';

      const handleWorkerMessage = (event: MessageEvent<G2PWorkerResponse>) => {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'ready') {
          if (this.mode === 'worker-connecting') {
            this.clearHandshakeTimer();
            this.mode = 'worker-ready';
            const queued = this.queuedBeforeReady.splice(0);
            for (const job of queued) {
              this.sendJobToWorker(job);
            }
          }
          return;
        }

        if (data.type === 'result') {
          const job = this.pending.get(data.id);
          if (!job) return;
          this.pending.delete(data.id);
          job.resolve(data.result);
          return;
        }

        if (data.type === 'error') {
          const job = this.pending.get(data.id);
          if (!job) return;
          this.pending.delete(data.id);
          // Fallback to main thread for resilience if worker asset fetch failed.
          this.runJobOnMainThread(job);
        }
      };

      const handleWorkerError = () => {
        this.fallbackToMainThread();
      };

      w.onmessage = handleWorkerMessage;
      w.onerror = handleWorkerError;
      if (typeof w.addEventListener === 'function') {
        w.addEventListener('error', handleWorkerError);
        w.addEventListener('messageerror', handleWorkerError);
      }

      this.handshakeTimer = setTimeout(() => {
        if (this.mode === 'worker-connecting') {
          this.fallbackToMainThread();
        }
      }, this.handshakeTimeoutMs);

      w.postMessage({ type: 'init', baseUrl: this.baseUrl } satisfies G2PWorkerRequest);
    } catch {
      this.fallbackToMainThread();
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private fallbackToMainThread(): void {
    this.clearHandshakeTimer();
    if (this.worker) {
      try {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.terminate();
      } catch {
        // Ignore terminate errors.
      }
      this.worker = null;
    }
    this.mode = 'main';

    const toReplay = [
      ...this.queuedBeforeReady.splice(0),
      ...Array.from(this.pending.values()),
    ];
    this.pending.clear();

    for (const job of toReplay) {
      this.runJobOnMainThread(job);
    }
  }

  private sendJobToWorker(job: PendingJob): void {
    if (!this.worker || this.mode !== 'worker-ready') {
      this.runJobOnMainThread(job);
      return;
    }
    this.pending.set(job.id, job);
    try {
      if (job.kind === 'preload') {
        this.worker.postMessage({
          type: 'preload',
          id: job.id,
          includeEnglish: job.includeEnglish,
        } satisfies G2PWorkerRequest);
      } else {
        this.worker.postMessage({
          type: 'phonemize',
          id: job.id,
          text: job.text ?? '',
          lang: job.lang,
          voiceId: job.voiceId,
        } satisfies G2PWorkerRequest);
      }
    } catch {
      this.pending.delete(job.id);
      this.fallbackToMainThread();
      this.runJobOnMainThread(job);
    }
  }

  private runJobOnMainThread(job: PendingJob): void {
    this.mainQueue = this.mainQueue.then(async () => {
      if (this.disposed) {
        job.reject(new Error('KokoroG2PClient disposed'));
        return;
      }
      try {
        const g2p = this.getMainG2P();
        if (job.kind === 'preload') {
          await g2p.preload(
            job.includeEnglish !== undefined ? { includeEnglish: job.includeEnglish } : undefined,
          );
          job.resolve(undefined);
          return;
        }
        this.mainSliceCounter += 1;
        if (this.mainSliceCounter % this.timeSliceBatchSize === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        const res = await g2p.phonemize(
          job.text ?? '',
          job.lang,
          job.voiceId !== undefined ? { voiceId: job.voiceId } : undefined,
        );
        job.resolve(res);
      } catch (err) {
        job.reject(err);
      }
    });
  }

  async preload(opts?: { includeEnglish?: boolean | undefined }): Promise<void> {
    this.ensureInitialized();
    const id = this.nextReqId++;
    return new Promise<void>((resolve, reject) => {
      const job: PendingJob = {
        id,
        kind: 'preload',
        includeEnglish: opts?.includeEnglish,
        resolve,
        reject,
      };
      if (this.mode === 'main') {
        this.runJobOnMainThread(job);
      } else if (this.mode === 'worker-connecting') {
        this.queuedBeforeReady.push(job);
      } else {
        this.sendJobToWorker(job);
      }
    });
  }

  async phonemize(
    text: string,
    lang?: string,
    opts?: { voiceId?: string | undefined },
  ): Promise<KokoroG2PResult> {
    const cacheKey = `${opts?.voiceId ?? 'zf_001'}\0${lang ?? ''}\0${text}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    this.ensureInitialized();
    const id = this.nextReqId++;
    const result = await new Promise<KokoroG2PResult>((resolve, reject) => {
      const job: PendingJob = {
        id,
        kind: 'phonemize',
        text,
        lang,
        voiceId: opts?.voiceId,
        resolve,
        reject,
      };
      if (this.mode === 'main') {
        this.runJobOnMainThread(job);
      } else if (this.mode === 'worker-connecting') {
        this.queuedBeforeReady.push(job);
      } else {
        this.sendJobToWorker(job);
      }
    });

    if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Annotates a list of Utterances with `phonemeIds`, `phonemeSpeeds`, and `phonemeSpans`
   * when their language is Chinese or English (or unspecified).
   */
  async annotateUtterances(utterances: Utterance[], voiceId: string): Promise<Utterance[]> {
    const annotated: Utterance[] = [];
    for (const u of utterances) {
      if (!isKokoroCompatibleLang(u.lang)) {
        annotated.push(u);
        continue;
      }
      if (
        u.phonemeIds &&
        u.phonemeIds.length > 0 &&
        u.phonemeSpeeds &&
        u.phonemeSpans
      ) {
        annotated.push(u);
        continue;
      }
      const res = await this.phonemize(u.text, u.lang, { voiceId });
      annotated.push({
        ...u,
        phonemeIds: res.phonemeIds,
        phonemeSpeeds: res.phonemeSpeeds,
        phonemeSpans: res.phonemeSpans,
      });
    }
    return annotated;
  }

  dispose(): void {
    this.disposed = true;
    this.clearHandshakeTimer();
    if (this.worker) {
      try {
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.terminate();
      } catch {
        // Ignore.
      }
      this.worker = null;
    }
    this.queuedBeforeReady.length = 0;
    this.pending.clear();
  }
}

export function isKokoroCompatibleLang(lang?: string): boolean {
  if (!lang) return true;
  const lower = lang.trim().toLowerCase();
  return lower === '' || lower.startsWith('zh') || lower.startsWith('cmn') || lower.startsWith('en');
}
