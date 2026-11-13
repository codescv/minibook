import type {
  KokoroWordSpan,
  SpeechModelBackend,
  SynthRequest,
  VoiceRef,
  WordMark,
} from '@minibook/core';
import { KokoroG2PClient, type MinimalWorkerLike } from './KokoroG2PClient';
import {
  KokoroSynthesisCore,
  type KokoroCoreEnv,
  type KokoroSynthesizeOutput,
  type KokoroSynthesizePayload,
  type KokoroWorkerRequest,
  type KokoroWorkerResponse,
} from './kokoro.worker';

export interface KokoroWebEngineOptions {
  baseUrl?: string | undefined;
  idleTimeoutMs?: number | undefined;
  workerFactory?: (() => MinimalWorkerLike) | undefined;
  coreEnv?: KokoroCoreEnv | undefined;
  g2pClient?: KokoroG2PClient | undefined;
  onEngineSlow?: ((ev: { type: 'engine-slow'; rtf: number; engine: 'kokoro' }) => void) | undefined;
  onBackendResolved?: ((backend: SpeechModelBackend) => void) | undefined;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

export class KokoroWebEngine {
  private readonly baseUrl: string;
  private readonly idleTimeoutMs: number;
  private readonly workerFactory?: (() => MinimalWorkerLike) | undefined;
  private readonly coreEnv?: KokoroCoreEnv | undefined;
  private readonly onEngineSlow?:
    | ((ev: { type: 'engine-slow'; rtf: number; engine: 'kokoro' }) => void)
    | undefined;
  private readonly onBackendResolved?: ((backend: SpeechModelBackend) => void) | undefined;

  private g2p: KokoroG2PClient | null;
  private ownsG2P: boolean;

  private worker: MinimalWorkerLike | null = null;
  private inProcessCore: KokoroSynthesisCore | null = null;
  private backend: SpeechModelBackend = 'wasm';
  private nextReqId = 1;
  private pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: unknown) => void }
  >();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: KokoroWebEngineOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.workerFactory = options.workerFactory;
    this.coreEnv = options.coreEnv;
    this.onEngineSlow = options.onEngineSlow;
    this.onBackendResolved = options.onBackendResolved;

    if (options.g2pClient) {
      this.g2p = options.g2pClient;
      this.ownsG2P = false;
    } else {
      this.g2p = null;
      this.ownsG2P = true;
    }
  }

  getBackend(): SpeechModelBackend {
    return this.backend;
  }

  private getG2P(): KokoroG2PClient {
    if (!this.g2p) {
      this.g2p = new KokoroG2PClient({ baseUrl: this.baseUrl });
    }
    return this.g2p;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    if (this.idleTimeoutMs > 0) {
      this.idleTimer = setTimeout(() => {
        void this.dispose();
      }, this.idleTimeoutMs);
    }
  }

  private shouldUseInProcessCore(): boolean {
    if (this.coreEnv) return true;
    if (this.workerFactory) return false;
    const isJsdom =
      typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent ?? '');
    return typeof Worker === 'undefined' || isJsdom;
  }

  private ensureInProcessCore(): KokoroSynthesisCore {
    if (!this.inProcessCore) {
      this.inProcessCore = new KokoroSynthesisCore({
        baseUrl: this.baseUrl,
        ...this.coreEnv,
        onEngineSlow: (rtf) => {
          this.coreEnv?.onEngineSlow?.(rtf);
          this.onEngineSlow?.({ type: 'engine-slow', rtf, engine: 'kokoro' });
        },
      });
    }
    return this.inProcessCore;
  }

  private ensureWorker(): MinimalWorkerLike {
    if (this.worker) return this.worker;
    const w = this.workerFactory
      ? this.workerFactory()
      : (new Worker(new URL('./kokoro.worker.ts', import.meta.url), {
          type: 'module',
        }) as unknown as MinimalWorkerLike);

    w.onmessage = (event: MessageEvent<KokoroWorkerResponse>) => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'engine-slow') {
        this.onEngineSlow?.({ type: 'engine-slow', rtf: msg.rtf, engine: 'kokoro' });
        return;
      }

      if (msg.type === 'ready') {
        if (msg.backend) {
          this.backend = msg.backend;
          this.onBackendResolved?.(msg.backend);
        }
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            entry.resolve(msg.backend ?? this.backend);
          }
        }
        return;
      }

      if (msg.type === 'synthesized') {
        if (msg.backend) {
          this.backend = msg.backend;
          this.onBackendResolved?.(msg.backend);
        }
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          const out: KokoroSynthesizeOutput = {
            wav: new Uint8Array(msg.wavBuffer),
            wordMarks: msg.wordMarks,
            durationMs: msg.durationMs,
            elapsedMs: msg.elapsedMs,
            rtf: msg.rtf,
            rtfEma: msg.rtfEma,
            backend: msg.backend,
          };
          entry.resolve(out);
        }
        return;
      }

      if (msg.type === 'error') {
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            entry.reject(new Error(msg.message));
          }
        }
      }
    };

    w.onerror = (err: any) => {
      const errorObj = new Error(err?.message || 'Kokoro Web Worker crashed');
      for (const [, p] of this.pending) {
        p.reject(errorObj);
      }
      this.pending.clear();
    };

    this.worker = w;
    return w;
  }

  async init(): Promise<SpeechModelBackend> {
    this.resetIdleTimer();
    if (this.shouldUseInProcessCore()) {
      const backend = await this.ensureInProcessCore().init();
      this.backend = backend;
      this.onBackendResolved?.(backend);
      return backend;
    }

    const w = this.ensureWorker();
    const id = this.nextReqId++;
    return new Promise<SpeechModelBackend>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'init', id, baseUrl: this.baseUrl } satisfies KokoroWorkerRequest);
    });
  }

  async synthesize(
    req: (
      | SynthRequest
      | {
          readonly text: string;
          readonly voice: VoiceRef;
          readonly rate?: number;
          readonly lang?: string;
          readonly phonemeIds?: readonly (readonly number[])[];
          readonly phonemeSpeeds?: readonly number[];
          readonly phonemeSpans?: readonly (readonly KokoroWordSpan[])[];
        }
    ) & { readonly rate?: number },
  ): Promise<
    KokoroSynthesizeOutput & {
      readonly audio: Uint8Array;
      readonly mimeType: string;
      readonly marks: WordMark[];
    }
  > {
    this.resetIdleTimer();

    const voiceId = 'voiceId' in req ? req.voiceId : (req.voice.voiceId ?? 'zf_001');
    const lang = 'lang' in req ? req.lang : undefined;

    let phonemeIds = req.phonemeIds ? req.phonemeIds.map((c) => [...c]) : undefined;
    let phonemeSpeeds = req.phonemeSpeeds ? [...req.phonemeSpeeds] : undefined;
    let phonemeSpans = req.phonemeSpans ? req.phonemeSpans.map((c) => [...c]) : undefined;

    if (!phonemeIds || phonemeIds.length === 0) {
      const g2pRes = await this.getG2P().phonemize(req.text, lang, {
        voiceId,
      });
      phonemeIds = g2pRes.phonemeIds.map((c) => [...c]);
      phonemeSpeeds = [...g2pRes.phonemeSpeeds];
      phonemeSpans = g2pRes.phonemeSpans.map((c) => [...c]);
    }

    const payload: KokoroSynthesizePayload = {
      text: req.text,
      voiceId,
      rate: req.rate,
      phonemeIds,
      phonemeSpeeds,
      phonemeSpans,
    };

    let out: KokoroSynthesizeOutput;
    if (this.shouldUseInProcessCore()) {
      out = await this.ensureInProcessCore().synthesize(payload);
      this.backend = out.backend;
      this.onBackendResolved?.(out.backend);
    } else {
      const w = this.ensureWorker();
      const id = this.nextReqId++;
      out = await new Promise<KokoroSynthesizeOutput>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        w.postMessage({ type: 'synthesize', id, payload } satisfies KokoroWorkerRequest);
      });
    }

    return {
      audio: out.wav,
      mimeType: 'audio/wav',
      marks: out.wordMarks,
      wav: out.wav,
      wordMarks: out.wordMarks,
      durationMs: out.durationMs,
      elapsedMs: out.elapsedMs,
      rtf: out.rtf,
      rtfEma: out.rtfEma,
      backend: out.backend,
    };
  }

  async dispose(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.inProcessCore) {
      await this.inProcessCore.dispose();
      this.inProcessCore = null;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'dispose' } satisfies KokoroWorkerRequest);
        this.worker.onmessage = null;
        this.worker.onerror = null;
        this.worker.terminate();
      } catch {
        // Ignore.
      }
      this.worker = null;
    }
    for (const [, p] of this.pending) {
      p.reject(new Error('KokoroWebEngine disposed'));
    }
    this.pending.clear();
    if (this.ownsG2P && this.g2p) {
      this.g2p.dispose();
      this.g2p = null;
    }
  }
}
