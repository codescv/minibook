import {
  MiniBookError,
  type HttpTransport,
  type TransportHttpRequest,
  type TransportHttpResponse,
} from '@minibook/core';
import type { FileSecretStore } from '../settings/secrets.js';
import { assertAllowedOutboundSpeechUrl } from './allowlist.js';

const MAX_SPEECH_HTTP_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface NodeHttpTransportOptions {
  readonly secrets: FileSecretStore;
  readonly getAllowedCustomBaseUrl: () => string | null;
  readonly allowEdge?: () => boolean;
  readonly fetchImpl?: typeof fetch;
}

export function createNodeHttpTransport(options: NodeHttpTransportOptions): HttpTransport {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  return async (req: TransportHttpRequest): Promise<TransportHttpResponse> => {
    const allowEdge = options.allowEdge ? options.allowEdge() : true;
    const configuredCustomBaseUrl = options.getAllowedCustomBaseUrl();
    assertAllowedOutboundSpeechUrl(req.url, {
      allowEdge,
      configuredCustomBaseUrl,
    });

    const headers = options.secrets.substituteHeaders(req.headers);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onCallerAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) {
        clearTimeout(timer);
        throw new MiniBookError('cancelled', 'Speech HTTP request aborted');
      }
      req.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const bodyInit: BodyInit | undefined =
        req.body === undefined
          ? undefined
          : typeof req.body === 'string'
            ? req.body
            : new Uint8Array(req.body);

      const resp = await fetchFn(req.url, {
        method: req.method,
        headers,
        ...(bodyInit !== undefined ? { body: bodyInit } : {}),
        redirect: 'error',
        signal: controller.signal,
      });

      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((value, key) => {
        respHeaders[key.toLowerCase()] = value;
      });

      const contentLength = Number.parseInt(respHeaders['content-length'] ?? '', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_SPEECH_HTTP_BYTES) {
        throw new MiniBookError(
          'too-large',
          `Speech response exceeds ${MAX_SPEECH_HTTP_BYTES} bytes`,
        );
      }

      const bytes = await readBoundedStream(resp, MAX_SPEECH_HTTP_BYTES);
      return {
        status: resp.status,
        headers: respHeaders,
        body: bytes,
      };
    } catch (error) {
      if (error instanceof MiniBookError) throw error;
      if (req.signal?.aborted) {
        throw new MiniBookError('cancelled', 'Speech HTTP request cancelled', { cause: error });
      }
      if (timedOut) {
        throw new MiniBookError('network', `Speech HTTP request timed out after ${timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new MiniBookError(
        'network',
        error instanceof Error ? error.message : 'Speech HTTP request failed',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCallerAbort);
    }
  };
}

async function readBoundedStream(resp: Response, maxBytes: number): Promise<Uint8Array> {
  if (!resp.body) {
    const ab = await resp.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new MiniBookError('too-large', `Speech response exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(ab);
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MiniBookError('too-large', `Speech response exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
