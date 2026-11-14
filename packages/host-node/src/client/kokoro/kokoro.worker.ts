/**
 * Browser Web Worker running `onnxruntime-web` (`WebGPU -> WASM SIMD threaded` fallback)
 * for offline Kokoro-82M v1.1-zh synthesis (`TTS_V2_SPEC.md` §5.1).
 *
 * Uses `onnx/model.onnx` (fp32) exclusively — `fp16`, `q4f16`, and single-thread `q8`
 * produce NaNs in ORT-web (§0.3).
 */
import {
  KOKORO_SAMPLE_RATE,
  KOKORO_SELF_TEST_IDS,
  KOKORO_SELF_TEST_VOICE_ID,
  KOKORO_VOICE_BIN_BYTES,
  KOKORO_VOICE_DIM,
  encodeMonoPcm16Wav,
  kokoroStyleRowIndex,
  padKokoroTokenIds,
  wordMarksFromKokoroDurations,
  type KokoroWordSpan,
  type SpeechModelBackend,
  type WordMark,
} from '@minibook/core';

interface OrtTensorLike {
  readonly data: ArrayLike<number | bigint>;
  dispose?(): void;
}

interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

interface OrtModuleLike {
  readonly env: {
    wasm: {
      wasmPaths: string;
      numThreads: number;
    };
  };
  readonly Tensor: new (
    type: 'int64' | 'float32',
    data: BigInt64Array | Float32Array,
    dims: readonly number[],
  ) => unknown;
  readonly InferenceSession: {
    create(
      bytes: Uint8Array,
      opts: { executionProviders: string[]; graphOptimizationLevel: string },
    ): Promise<OrtSessionLike>;
  };
}

export type KokoroWorkerRequest =
  | {
      readonly type: 'init';
      readonly id: number;
      readonly baseUrl: string;
      readonly variant?: 'onnx-fp32' | 'onnx-q8';
      readonly selfTestVoiceId?: string;
    }
  | {
      readonly type: 'synth';
      readonly id: number;
      readonly baseUrl: string;
      readonly variant?: 'onnx-fp32' | 'onnx-q8';
      readonly voiceId: string;
      readonly text: string;
      readonly phonemeIds: readonly (readonly number[])[];
      readonly phonemeSpeeds?: readonly number[];
      readonly phonemeSpans?: readonly (readonly KokoroWordSpan[])[];
    };

export type KokoroWorkerResponse =
  | {
      readonly type: 'ready';
      readonly id: number;
      readonly backend: SpeechModelBackend;
    }
  | {
      readonly type: 'synth-ok';
      readonly id: number;
      readonly backend: SpeechModelBackend;
      readonly wav: ArrayBuffer;
      readonly durationMs: number;
      readonly marks: readonly WordMark[];
      readonly synthMs: number;
    }
  | {
      readonly type: 'error';
      readonly id: number;
      readonly code: 'model-selftest' | 'model-integrity' | 'speech-unavailable';
      readonly message: string;
    };

let ortModule: OrtModuleLike | null = null;
let session: OrtSessionLike | null = null;
let activeBackend: SpeechModelBackend | null = null;
const voiceCache = new Map<string, Float32Array>();

function resolveApiUrl(baseUrl: string, path: string): string {
  const cleanBase = baseUrl ? baseUrl.replace(/\/+$/, '') : self.location.origin;
  return `${cleanBase}${path}`;
}

async function loadOrt(): Promise<OrtModuleLike> {
  if (ortModule) return ortModule;
  const origin = self.location.origin;
  const mod = (await import(/* @vite-ignore */ `${origin}/ort/ort.webgpu.min.mjs`)) as OrtModuleLike;
  mod.env.wasm.wasmPaths = `${origin}/ort/`;
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  mod.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(2, Math.min(4, hw - 2)) : 1;
  ortModule = mod;
  return mod;
}

async function loadVoicePack(baseUrl: string, voiceId: string): Promise<Float32Array> {
  const cached = voiceCache.get(voiceId);
  if (cached) return cached;

  const url = resolveApiUrl(
    baseUrl,
    `/api/models/kokoro-v1.1-zh/file/voices/${encodeURIComponent(voiceId)}.bin`,
  );
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to load Kokoro voice "${voiceId}" (HTTP ${resp.status})`);
  }
  const ab = await resp.arrayBuffer();
  if (ab.byteLength !== KOKORO_VOICE_BIN_BYTES) {
    throw new Error(
      `Voice pack "${voiceId}" has unexpected byte length ${ab.byteLength} (expected ${KOKORO_VOICE_BIN_BYTES})`,
    );
  }
  const floats = new Float32Array(ab);
  voiceCache.set(voiceId, floats);
  return floats;
}

async function runSingleChunk(
  ort: OrtModuleLike,
  sess: OrtSessionLike,
  unpaddedIds: readonly number[],
  voiceFloats: Float32Array,
  speedVal: number,
): Promise<{ readonly waveform: Float32Array; readonly duration: ArrayLike<number | bigint> }> {
  const row = kokoroStyleRowIndex(unpaddedIds.length);
  const styleSlice = voiceFloats.subarray(row * KOKORO_VOICE_DIM, (row + 1) * KOKORO_VOICE_DIM);
  const padded = padKokoroTokenIds(unpaddedIds);
  const idsArr = new BigInt64Array(padded.length);
  for (let i = 0; i < padded.length; i++) {
    idsArr[i] = BigInt(padded[i]!);
  }
  const speedArr = new Float32Array([Number.isFinite(speedVal) && speedVal > 0 ? speedVal : 1.0]);

  const inputIdsTensor = new ort.Tensor('int64', idsArr, [1, padded.length]);
  const styleTensor = new ort.Tensor('float32', new Float32Array(styleSlice), [1, KOKORO_VOICE_DIM]);
  const speedTensor = new ort.Tensor('float32', speedArr, [1]);

  let outputs: Record<string, OrtTensorLike> | null = null;
  try {
    outputs = await sess.run({
      input_ids: inputIdsTensor,
      style: styleTensor,
      speed: speedTensor,
    });
    const waveOut = outputs['waveform'];
    const durOut = outputs['duration'];
    if (!waveOut) {
      throw new Error('Kokoro ONNX session returned no "waveform" output');
    }
    const rawWave = waveOut.data;
    const waveform = new Float32Array(rawWave.length);
    for (let i = 0; i < rawWave.length; i++) {
      waveform[i] = Number(rawWave[i]);
    }
    const duration = durOut
      ? Array.from({ length: durOut.data.length }, (_, i) => Number(durOut.data[i]))
      : [];
    return { waveform, duration };
  } finally {
    (inputIdsTensor as { dispose?: () => void }).dispose?.();
    (styleTensor as { dispose?: () => void }).dispose?.();
    (speedTensor as { dispose?: () => void }).dispose?.();
    if (outputs) {
      for (const t of Object.values(outputs)) {
        t.dispose?.();
      }
    }
  }
}

async function runSelfTest(
  ort: OrtModuleLike,
  sess: OrtSessionLike,
  baseUrl: string,
  voiceId: string,
): Promise<boolean> {
  try {
    const voiceFloats = await loadVoicePack(baseUrl, voiceId);
    const { waveform } = await runSingleChunk(ort, sess, KOKORO_SELF_TEST_IDS, voiceFloats, 1.0);
    const durationSec = waveform.length / KOKORO_SAMPLE_RATE;
    if (durationSec < 0.5 || durationSec > 4.0) return false;

    let maxAbs = 0;
    for (let i = 0; i < waveform.length; i++) {
      const s = waveform[i]!;
      if (!Number.isFinite(s)) return false;
      const a = Math.abs(s);
      if (a > maxAbs) maxAbs = a;
    }
    return maxAbs >= 0.01;
  } catch {
    return false;
  }
}

let activeVariant: 'onnx-fp32' | 'onnx-q8' | null = null;

async function ensureInitialized(
  baseUrl: string,
  selfTestVoiceId?: string,
  variant: 'onnx-fp32' | 'onnx-q8' = 'onnx-fp32',
): Promise<SpeechModelBackend> {
  if (session && activeBackend && activeVariant === variant) {
    return activeBackend;
  }
  if (session && activeVariant !== variant) {
    await session.release().catch(() => undefined);
    session = null;
    activeBackend = null;
    activeVariant = null;
  }

  const ort = await loadOrt();
  const relPath =
    variant === 'onnx-q8'
      ? '/api/models/kokoro-v1.1-zh/file/onnx/model_quantized.onnx'
      : '/api/models/kokoro-v1.1-zh/file/onnx/model.onnx';
  const modelResp = await fetch(resolveApiUrl(baseUrl, relPath));
  if (!modelResp.ok) {
    throw new Error(`Kokoro ${relPath} unavailable (HTTP ${modelResp.status})`);
  }
  const modelBytes = new Uint8Array(await modelResp.arrayBuffer());

  const navGpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const adapter = navGpu ? await navGpu.requestAdapter().catch(() => null) : null;
  const candidates: readonly SpeechModelBackend[] = adapter ? ['webgpu', 'wasm'] : ['wasm'];
  const testVoice = selfTestVoiceId || KOKORO_SELF_TEST_VOICE_ID;

  for (const ep of candidates) {
    let candidateSession: OrtSessionLike | null = null;
    try {
      candidateSession = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      if (await runSelfTest(ort, candidateSession, baseUrl, testVoice)) {
        session = candidateSession;
        activeBackend = ep;
        activeVariant = variant;
        return ep;
      }
      await candidateSession.release().catch(() => undefined);
    } catch {
      if (candidateSession) {
        await candidateSession.release().catch(() => undefined);
      }
    }
  }

  const err = new Error('Kokoro ONNX self-test failed on all execution providers');
  (err as Error & { code?: string }).code = 'model-selftest';
  throw err;
}

const DedicatedWorkerCtor = (
  globalThis as unknown as { DedicatedWorkerGlobalScope?: abstract new () => unknown }
).DedicatedWorkerGlobalScope;

const isDedicatedWorkerScope =
  (typeof DedicatedWorkerCtor === 'function' &&
    typeof self !== 'undefined' &&
    self instanceof DedicatedWorkerCtor) ||
  (typeof self !== 'undefined' &&
    typeof window === 'undefined' &&
    typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function');

if (isDedicatedWorkerScope) {
  self.addEventListener('message', async (ev: MessageEvent<KokoroWorkerRequest>) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== 'object') return;
    try {
    if (msg.type === 'init') {
      const backend = await ensureInitialized(msg.baseUrl, msg.selfTestVoiceId, msg.variant ?? 'onnx-fp32');
      const reply: KokoroWorkerResponse = { type: 'ready', id: msg.id, backend };
      self.postMessage(reply);
      return;
    }

    if (msg.type === 'synth') {
      const t0 = performance.now();
      const backend = await ensureInitialized(msg.baseUrl, undefined, msg.variant ?? 'onnx-fp32');
      const ort = await loadOrt();
      const voiceFloats = await loadVoicePack(msg.baseUrl, msg.voiceId);

      const waveChunks: Float32Array[] = [];
      const allMarks: WordMark[] = [];
      let totalSamples = 0;
      let tOffsetMs = 0;

      for (let c = 0; c < msg.phonemeIds.length; c++) {
        const ids = msg.phonemeIds[c]!;
        if (ids.length === 0) continue;
        const speedVal = msg.phonemeSpeeds?.[c] ?? 1.0;
        const { waveform, duration } = await runSingleChunk(ort, session!, ids, voiceFloats, speedVal);
        waveChunks.push(waveform);
        totalSamples += waveform.length;

        const spans = msg.phonemeSpans?.[c];
        if (spans && spans.length > 0 && duration.length > 0) {
          allMarks.push(...wordMarksFromKokoroDurations(spans, duration, tOffsetMs, msg.text));
        }
        tOffsetMs += waveform.length / 24;
      }

      const merged = new Float32Array(totalSamples);
      let cursor = 0;
      for (const chunk of waveChunks) {
        merged.set(chunk, cursor);
        cursor += chunk.length;
      }

      const encoded = encodeMonoPcm16Wav(merged, KOKORO_SAMPLE_RATE);
      const synthMs = Math.max(1, Math.round(performance.now() - t0));
      const wavBuffer = encoded.wav.slice().buffer;
      const reply: KokoroWorkerResponse = {
        type: 'synth-ok',
        id: msg.id,
        backend,
        wav: wavBuffer,
        durationMs: encoded.durationMs,
        marks: allMarks,
        synthMs,
      };
      (self as unknown as { postMessage(msg: unknown, transfer: Transferable[]): void }).postMessage(
        reply,
        [wavBuffer],
      );
    }
  } catch (err) {
    const code =
      (err as { code?: string })?.code === 'model-selftest'
        ? 'model-selftest'
        : (err as { code?: string })?.code === 'model-integrity'
          ? 'model-integrity'
          : 'speech-unavailable';
    const reply: KokoroWorkerResponse = {
      type: 'error',
      id: msg.id,
      code,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(reply);
  }
  });
}
