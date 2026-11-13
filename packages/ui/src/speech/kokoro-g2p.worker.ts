import { createKokoroG2P, type KokoroG2P, type KokoroG2PResult } from '@minibook/core';

export type G2PWorkerRequest =
  | { type: 'init'; baseUrl?: string | undefined }
  | { type: 'preload'; id: number; includeEnglish?: boolean | undefined }
  | {
      type: 'phonemize';
      id: number;
      text: string;
      lang?: string | undefined;
      voiceId?: string | undefined;
    };

export type G2PWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; result?: KokoroG2PResult | undefined }
  | { type: 'error'; id: number; message: string };

interface WorkerGlobalLike {
  onmessage: ((event: MessageEvent<G2PWorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

let baseUrl = '';
let g2pInstance: KokoroG2P | null = null;

function getG2P(): KokoroG2P {
  if (!g2pInstance) {
    g2pInstance = createKokoroG2P({
      loadAsset: async (name: string): Promise<Uint8Array> => {
        const prefix = baseUrl ? baseUrl.replace(/\/$/, '') : '';
        const res = await fetch(`${prefix}/kokoro-g2p/v1/${name}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} loading G2P asset ${name}`);
        }
        return new Uint8Array(await res.arrayBuffer());
      },
    });
  }
  return g2pInstance;
}

const workerScope =
  typeof self !== 'undefined' ? (self as unknown as WorkerGlobalLike) : null;

if (workerScope && typeof workerScope.postMessage === 'function') {
  workerScope.onmessage = async (event: MessageEvent<G2PWorkerRequest>) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init') {
      if (typeof msg.baseUrl === 'string' && msg.baseUrl !== baseUrl) {
        baseUrl = msg.baseUrl;
        g2pInstance = null;
      }
      workerScope.postMessage({ type: 'ready' } satisfies G2PWorkerResponse);
      return;
    }

    if (msg.type === 'preload') {
      try {
        await getG2P().preload(
          msg.includeEnglish !== undefined ? { includeEnglish: msg.includeEnglish } : undefined,
        );
        workerScope.postMessage({ type: 'result', id: msg.id } satisfies G2PWorkerResponse);
      } catch (err) {
        workerScope.postMessage({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies G2PWorkerResponse);
      }
      return;
    }

    if (msg.type === 'phonemize') {
      try {
        const result = await getG2P().phonemize(
          msg.text,
          msg.lang,
          msg.voiceId !== undefined ? { voiceId: msg.voiceId } : undefined,
        );
        workerScope.postMessage({
          type: 'result',
          id: msg.id,
          result,
        } satisfies G2PWorkerResponse);
      } catch (err) {
        workerScope.postMessage({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        } satisfies G2PWorkerResponse);
      }
    }
  };

  // Announce readiness immediately on boot as well as in response to 'init'.
  try {
    workerScope.postMessage({ type: 'ready' } satisfies G2PWorkerResponse);
  } catch {
    // Ignore in non-worker test environments.
  }
}
