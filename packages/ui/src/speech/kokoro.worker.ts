import {
  KOKORO_SAMPLES_PER_FRAME,
  KOKORO_SAMPLE_RATE,
  KOKORO_VOICE_BIN_BYTES,
  KOKORO_VOICE_DIM,
  encodeMonoPcm16Wav,
  kokoroVoiceSliceByteOffset,
  wordMarksFromKokoroDurations,
  type KokoroWordSpan,
  type SpeechModelBackend,
  type WordMark,
} from '@minibook/core';

export const KOKORO_SELF_TEST_IDS: readonly number[] = [73, 127, 172, 88, 108, 169, 4];
export const KOKORO_SELF_TEST_VOICE = 'zf_001';
export const KOKORO_MIN_SELF_TEST_SAMPLES = 12_000; // 0.5 s @ 24 kHz
export const KOKORO_MAX_SELF_TEST_SAMPLES = 96_000; // 4.0 s @ 24 kHz

export interface OrtTensorLike {
  data: ArrayLike<number | bigint>;
  dims?: readonly number[];
  dispose?: () => void;
}

export interface OrtSessionLike {
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>;
  release?: () => Promise<void> | void;
}

export interface OrtRuntimeLike {
  env?: {
    wasm?: {
      wasmPaths?: string;
      numThreads?: number;
    };
  };
  Tensor: new (
    type: 'int64' | 'float32',
    data: BigInt64Array | Float32Array,
    dims: readonly number[],
  ) => OrtTensorLike;
  InferenceSession: {
    create(
      modelSource: Uint8Array | ArrayBuffer | string,
      options?: { executionProviders?: readonly string[]; graphOptimizationLevel?: string },
    ): Promise<OrtSessionLike>;
  };
}

export interface KokoroSynthesizePayload {
  text: string;
  voiceId: string;
  rate?: number | undefined;
  phonemeIds: number[][];
  phonemeSpeeds?: number[] | undefined;
  phonemeSpans?: KokoroWordSpan[][] | undefined;
}

export interface KokoroSynthesizeOutput {
  wav: Uint8Array;
  wordMarks: WordMark[];
  durationMs: number;
  elapsedMs: number;
  rtf: number;
  rtfEma: number;
  backend: SpeechModelBackend;
}

export type KokoroWorkerRequest =
  | { type: 'init'; id: number; baseUrl?: string | undefined }
  | { type: 'synthesize'; id: number; payload: KokoroSynthesizePayload }
  | { type: 'dispose'; id?: number | undefined };

export type KokoroWorkerResponse =
  | { type: 'ready'; id?: number | undefined; backend?: SpeechModelBackend | undefined }
  | {
      type: 'synthesized';
      id: number;
      wavBuffer: ArrayBuffer;
      wordMarks: WordMark[];
      durationMs: number;
      elapsedMs: number;
      rtf: number;
      rtfEma: number;
      backend: SpeechModelBackend;
    }
  | { type: 'engine-slow'; rtf: number }
  | { type: 'error'; id?: number | undefined; message: string };

export interface KokoroCoreEnv {
  baseUrl?: string | undefined;
  loadOrt?: (() => Promise<OrtRuntimeLike>) | undefined;
  fetchBinary?: ((path: string) => Promise<Uint8Array>) | undefined;
  probeWebGpu?: (() => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
  onEngineSlow?: ((rtf: number) => void) | undefined;
}

interface WorkerGlobalLike {
  onmessage: ((event: MessageEvent<KokoroWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Extracts a 256-float style vector from a `510 * 1 * 256` float32 LE voice `.bin`
 * at `row = clamp(unpaddedTokenCount - 1, 0, 509)`.
 */
export function sliceKokoroVoiceStyle(
  voiceBin: Uint8Array,
  unpaddedTokenCount: number,
): Float32Array {
  if (voiceBin.byteLength !== KOKORO_VOICE_BIN_BYTES) {
    throw new Error(
      `Invalid Kokoro voice binary size: expected ${KOKORO_VOICE_BIN_BYTES}, got ${voiceBin.byteLength}`,
    );
  }
  const byteOffset = kokoroVoiceSliceByteOffset(unpaddedTokenCount);
  const view = new DataView(voiceBin.buffer, voiceBin.byteOffset + byteOffset, KOKORO_VOICE_DIM * 4);
  const out = new Float32Array(KOKORO_VOICE_DIM);
  for (let i = 0; i < KOKORO_VOICE_DIM; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export class KokoroSynthesisCore {
  private readonly baseUrl: string;
  private readonly loadOrtFn: () => Promise<OrtRuntimeLike>;
  private readonly fetchBinaryFn: (path: string) => Promise<Uint8Array>;
  private readonly probeWebGpuFn: () => Promise<boolean>;
  private readonly nowFn: () => number;
  private readonly onEngineSlow?: ((rtf: number) => void) | undefined;

  private ort: OrtRuntimeLike | null = null;
  private session: OrtSessionLike | null = null;
  private backend: SpeechModelBackend = 'wasm';
  private initPromise: Promise<SpeechModelBackend> | null = null;
  private voiceCache = new Map<string, Uint8Array>();

  private rtfEma = 0;
  private rtfSampleCount = 0;

  constructor(env: KokoroCoreEnv = {}) {
    this.baseUrl = (env.baseUrl ?? '').replace(/\/$/, '');
    this.nowFn = env.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.onEngineSlow = env.onEngineSlow;

    this.loadOrtFn =
      env.loadOrt ??
      (async (): Promise<OrtRuntimeLike> => {
        const origin =
          typeof self !== 'undefined' && self.location?.origin ? self.location.origin : this.baseUrl;
        const ortUrl = `${origin}/ort/ort.webgpu.min.mjs`;
        try {
          return (await import(/* @vite-ignore */ ortUrl)) as unknown as OrtRuntimeLike;
        } catch {
          const modName = 'onnxruntime-web';
          return (await import(/* @vite-ignore */ modName)) as unknown as OrtRuntimeLike;
        }
      });

    this.fetchBinaryFn =
      env.fetchBinary ??
      (async (relPath: string): Promise<Uint8Array> => {
        const url = `${this.baseUrl}${relPath.startsWith('/') ? relPath : `/${relPath}`}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching ${relPath}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      });

    this.probeWebGpuFn =
      env.probeWebGpu ??
      (async (): Promise<boolean> => {
        if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false;
        try {
          const adapter = await (navigator as any).gpu?.requestAdapter?.();
          return Boolean(adapter);
        } catch {
          return false;
        }
      });
  }

  getBackend(): SpeechModelBackend {
    return this.backend;
  }

  getRtfEma(): number {
    return this.rtfEma;
  }

  async init(): Promise<SpeechModelBackend> {
    if (this.session) return this.backend;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const ort = await this.loadOrtFn();
      this.ort = ort;
      if (ort.env?.wasm) {
        ort.env.wasm.wasmPaths = `${this.baseUrl}/ort/`;
        const isIsolated = typeof self !== 'undefined' && Boolean((self as any).crossOriginIsolated);
        const cores =
          (typeof navigator !== 'undefined' && Number(navigator.hardwareConcurrency)) || 4;
        ort.env.wasm.numThreads = isIsolated ? Math.max(2, Math.min(4, cores - 2)) : 1;
      }

      const [hasWebGpu, modelBytes] = await Promise.all([
        this.probeWebGpuFn(),
        this.fetchBinaryFn('/api/models/kokoro-v1.1-zh/file/onnx/model.onnx'),
      ]);

      const candidateProviders: Array<'webgpu' | 'wasm'> = hasWebGpu
        ? ['webgpu', 'wasm']
        : ['wasm'];

      let lastErr: unknown = null;
      for (const provider of candidateProviders) {
        let candidateSession: OrtSessionLike | null = null;
        try {
          candidateSession = await ort.InferenceSession.create(modelBytes, {
            executionProviders: [provider],
            graphOptimizationLevel: 'all',
          });
          await this.runSelfTest(ort, candidateSession);
          this.session = candidateSession;
          this.backend = provider;
          return provider;
        } catch (err) {
          lastErr = err;
          try {
            await candidateSession?.release?.();
          } catch {
            // Ignore release error.
          }
        }
      }

      this.initPromise = null;
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`Kokoro session initialization failed: ${String(lastErr)}`);
    })();

    return this.initPromise;
  }

  private async loadVoiceBin(voiceId: string): Promise<Uint8Array> {
    const cached = this.voiceCache.get(voiceId);
    if (cached) return cached;
    const bytes = await this.fetchBinaryFn(`/api/models/kokoro-v1.1-zh/file/voices/${voiceId}.bin`);
    if (bytes.byteLength !== KOKORO_VOICE_BIN_BYTES) {
      throw new Error(
        `Damaged voice file ${voiceId}.bin: expected ${KOKORO_VOICE_BIN_BYTES} bytes, got ${bytes.byteLength}`,
      );
    }
    this.voiceCache.set(voiceId, bytes);
    return bytes;
  }

  private async runChunk(
    ort: OrtRuntimeLike,
    session: OrtSessionLike,
    unpaddedIds: readonly number[],
    voiceBin: Uint8Array,
    speedValue: number,
  ): Promise<{ waveform: Float32Array; durations: number[] }> {
    if (unpaddedIds.length === 0) {
      return { waveform: new Float32Array(0), durations: [] };
    }
    const clampedIds = unpaddedIds.length > 510 ? unpaddedIds.slice(0, 510) : unpaddedIds;
    const paddedLen = clampedIds.length + 2;
    const paddedIds = new BigInt64Array(paddedLen);
    paddedIds[0] = 0n;
    for (let i = 0; i < clampedIds.length; i++) {
      paddedIds[i + 1] = BigInt(clampedIds[i]!);
    }
    paddedIds[paddedLen - 1] = 0n;

    const styleVec = sliceKokoroVoiceStyle(voiceBin, clampedIds.length);
    const speedVec = new Float32Array([Number.isFinite(speedValue) && speedValue > 0 ? speedValue : 1.0]);

    const inputIdsTensor = new ort.Tensor('int64', paddedIds, [1, paddedLen]);
    const styleTensor = new ort.Tensor('float32', styleVec, [1, KOKORO_VOICE_DIM]);
    const speedTensor = new ort.Tensor('float32', speedVec, [1]);

    let outputs: Record<string, OrtTensorLike> | null = null;
    try {
      outputs = await session.run({
        input_ids: inputIdsTensor,
        style: styleTensor,
        speed: speedTensor,
      });

      const waveTensor = outputs.waveform ?? outputs.audio ?? Object.values(outputs)[0];
      if (!waveTensor || !waveTensor.data) {
        throw new Error('Kokoro session returned no waveform tensor');
      }
      const rawWave = waveTensor.data;
      const waveform =
        rawWave instanceof Float32Array
          ? new Float32Array(rawWave)
          : Float32Array.from(Array.from(rawWave, (v) => Number(v)));

      const durTensor = outputs.duration ?? outputs.durations;
      let durations: number[];
      if (durTensor && durTensor.data && durTensor.data.length > 0) {
        durations = Array.from(durTensor.data, (v) => Number(v));
      } else {
        // Fallback uniform frame distribution if duration output is absent
        const totalFrames = Math.max(1, Math.round(waveform.length / KOKORO_SAMPLES_PER_FRAME));
        const perToken = totalFrames / paddedLen;
        durations = Array.from({ length: paddedLen }, () => perToken);
      }

      return { waveform, durations };
    } finally {
      inputIdsTensor.dispose?.();
      styleTensor.dispose?.();
      speedTensor.dispose?.();
      if (outputs) {
        for (const t of Object.values(outputs)) {
          t?.dispose?.();
        }
      }
    }
  }

  private async runSelfTest(ort: OrtRuntimeLike, session: OrtSessionLike): Promise<void> {
    const voiceBin = await this.loadVoiceBin(KOKORO_SELF_TEST_VOICE);
    const { waveform } = await this.runChunk(ort, session, KOKORO_SELF_TEST_IDS, voiceBin, 1.0);

    if (
      waveform.length < KOKORO_MIN_SELF_TEST_SAMPLES ||
      waveform.length > KOKORO_MAX_SELF_TEST_SAMPLES
    ) {
      throw new Error(
        `Kokoro self-test duration out of range: ${waveform.length} samples (expected ${KOKORO_MIN_SELF_TEST_SAMPLES}..${KOKORO_MAX_SELF_TEST_SAMPLES})`,
      );
    }

    let peak = 0;
    for (let i = 0; i < waveform.length; i++) {
      const s = waveform[i]!;
      if (!Number.isFinite(s)) {
        throw new Error(`Kokoro self-test produced non-finite sample at index ${i}`);
      }
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }

    if (peak < 0.01) {
      throw new Error(`Kokoro self-test produced silent output (peak=${peak})`);
    }
  }

  async synthesize(payload: KokoroSynthesizePayload): Promise<KokoroSynthesizeOutput> {
    await this.init();
    if (!this.ort || !this.session) {
      throw new Error('Kokoro session is not initialized');
    }

    const chunks = payload.phonemeIds;
    if (!chunks || chunks.length === 0) {
      throw new Error('Kokoro synthesize requires non-empty phonemeIds chunks');
    }

    const startMs = this.nowFn();
    const voiceBin = await this.loadVoiceBin(payload.voiceId);
    const userRate = Number.isFinite(payload.rate) && (payload.rate ?? 0) > 0 ? payload.rate! : 1.0;

    const chunkWaveforms: Float32Array[] = [];
    const wordMarks: WordMark[] = [];
    const interChunkPauseSamples = Math.round(0.08 * KOKORO_SAMPLE_RATE); // 80 ms pause between chunks
    const frameMs = (KOKORO_SAMPLES_PER_FRAME / KOKORO_SAMPLE_RATE) * 1000; // 25 ms

    let totalSamples = 0;
    let chunkTimeOffsetMs = 0;

    for (let c = 0; c < chunks.length; c++) {
      const ids = chunks[c]!;
      if (!ids || ids.length === 0) continue;

      const baseSpeed = payload.phonemeSpeeds?.[c] ?? 1.0;
      const effectiveSpeed = Math.max(0.5, Math.min(2.0, baseSpeed * userRate));
      const { waveform, durations } = await this.runChunk(
        this.ort,
        this.session,
        ids,
        voiceBin,
        effectiveSpeed,
      );

      const spansForChunk = payload.phonemeSpans?.[c] ?? [];
      if (spansForChunk.length > 0) {
        const marks = wordMarksFromKokoroDurations(
          spansForChunk,
          durations,
          chunkTimeOffsetMs,
          payload.text,
          frameMs,
        );
        wordMarks.push(...marks);
      }

      chunkWaveforms.push(waveform);
      totalSamples += waveform.length;
      chunkTimeOffsetMs += (waveform.length / KOKORO_SAMPLE_RATE) * 1000;

      if (c < chunks.length - 1) {
        const silence = new Float32Array(interChunkPauseSamples);
        chunkWaveforms.push(silence);
        totalSamples += silence.length;
        chunkTimeOffsetMs += 80;
      }
    }

    const combined = new Float32Array(totalSamples);
    let offset = 0;
    for (const part of chunkWaveforms) {
      combined.set(part, offset);
      offset += part.length;
    }

    const { wav, durationMs } = encodeMonoPcm16Wav(combined, KOKORO_SAMPLE_RATE, {
      minPeak: 1e-3,
    });

    const elapsedMs = Math.max(1, this.nowFn() - startMs);
    const rtf = durationMs > 0 ? elapsedMs / durationMs : 0;
    this.rtfEma = this.rtfSampleCount === 0 ? rtf : 0.7 * this.rtfEma + 0.3 * rtf;
    this.rtfSampleCount += 1;

    if (this.rtfEma >= 0.9) {
      this.onEngineSlow?.(this.rtfEma);
    }

    return {
      wav,
      wordMarks,
      durationMs,
      elapsedMs,
      rtf,
      rtfEma: this.rtfEma,
      backend: this.backend,
    };
  }

  async dispose(): Promise<void> {
    const sess = this.session;
    this.session = null;
    this.initPromise = null;
    this.voiceCache.clear();
    try {
      await sess?.release?.();
    } catch {
      // Ignore release errors.
    }
  }
}

const workerScope =
  typeof self !== 'undefined' ? (self as unknown as WorkerGlobalLike) : null;

if (workerScope && typeof workerScope.postMessage === 'function') {
  let core: KokoroSynthesisCore | null = null;
  let currentBaseUrl = '';

  const ensureCore = (baseUrl?: string): KokoroSynthesisCore => {
    const nextBase = baseUrl ?? currentBaseUrl;
    if (!core || (baseUrl !== undefined && nextBase !== currentBaseUrl)) {
      currentBaseUrl = nextBase;
      core = new KokoroSynthesisCore({
        baseUrl: currentBaseUrl,
        onEngineSlow: (rtf) => {
          workerScope.postMessage({ type: 'engine-slow', rtf } satisfies KokoroWorkerResponse);
        },
      });
    }
    return core;
  };

  workerScope.onmessage = async (event: MessageEvent<KokoroWorkerRequest>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      try {
        const c = ensureCore(msg.baseUrl);
        const backend = await c.init();
        workerScope.postMessage({
          type: 'ready',
          id: msg.id,
          backend,
        } satisfies KokoroWorkerResponse);
      } catch (err) {
        workerScope.postMessage({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies KokoroWorkerResponse);
      }
      return;
    }

    if (msg.type === 'synthesize') {
      try {
        const c = ensureCore();
        const out = await c.synthesize(msg.payload);
        const wavCopy = new Uint8Array(out.wav.byteLength);
        wavCopy.set(out.wav);
        workerScope.postMessage(
          {
            type: 'synthesized',
            id: msg.id,
            wavBuffer: wavCopy.buffer,
            wordMarks: out.wordMarks,
            durationMs: out.durationMs,
            elapsedMs: out.elapsedMs,
            rtf: out.rtf,
            rtfEma: out.rtfEma,
            backend: out.backend,
          } satisfies KokoroWorkerResponse,
          [wavCopy.buffer],
        );
      } catch (err) {
        workerScope.postMessage({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies KokoroWorkerResponse);
      }
      return;
    }

    if (msg.type === 'dispose') {
      try {
        await core?.dispose();
        core = null;
      } finally {
        if (msg.id !== undefined) {
          workerScope.postMessage({ type: 'ready', id: msg.id } satisfies KokoroWorkerResponse);
        }
      }
    }
  };
}
