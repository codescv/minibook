import {
  KokoroSynthesisCore,
  type KokoroWorkerRequest,
  type KokoroWorkerResponse,
} from './kokoro-synthesis-core';

export {
  KOKORO_MAX_SELF_TEST_SAMPLES,
  KOKORO_MIN_SELF_TEST_SAMPLES,
  KOKORO_SELF_TEST_IDS,
  KOKORO_SELF_TEST_VOICE,
  KokoroSynthesisCore,
  sliceKokoroVoiceStyle,
  type KokoroCoreEnv,
  type KokoroSynthesizeOutput,
  type KokoroSynthesizePayload,
  type KokoroWorkerRequest,
  type KokoroWorkerResponse,
  type OrtRuntimeLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from './kokoro-synthesis-core';

interface WorkerGlobalLike {
  onmessage: ((event: MessageEvent<KokoroWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
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

const workerScope = isDedicatedWorkerScope
  ? (self as unknown as WorkerGlobalLike)
  : null;

if (workerScope) {
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
    const msg = event?.data;
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
