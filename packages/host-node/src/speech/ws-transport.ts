import {
  MiniBookError,
  type SocketConnection,
  type SocketHandlers,
  type SocketOpenOptions,
  type SocketTransport,
} from '@minibook/core';
import WebSocket from 'ws';
import type { FileSecretStore } from '../settings/secrets.js';
import { assertAllowedOutboundSpeechUrl } from './allowlist.js';

const DEFAULT_WS_TIMEOUT_MS = 20_000;

export interface NodeWsTransportOptions {
  readonly secrets: FileSecretStore;
  readonly allowEdge?: () => boolean;
}

export function createNodeWsTransport(options: NodeWsTransportOptions): SocketTransport {
  return (openOpts: SocketOpenOptions, handlers: SocketHandlers): Promise<SocketConnection> => {
    const allowEdge = options.allowEdge ? options.allowEdge() : true;
    assertAllowedOutboundSpeechUrl(openOpts.url, {
      allowEdge,
      configuredCustomBaseUrl: null,
    });

    if (openOpts.signal?.aborted) {
      return Promise.reject(new MiniBookError('cancelled', 'Speech WebSocket aborted before open'));
    }

    const headers = options.secrets.substituteHeaders(openOpts.headers);
    const timeoutMs = openOpts.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS;

    return new Promise<SocketConnection>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(openOpts.url, {
        headers,
        handshakeTimeout: timeoutMs,
        followRedirects: false,
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new MiniBookError('network', `Speech WebSocket handshake timed out (${timeoutMs}ms)`));
          ws.terminate();
        }
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new MiniBookError('cancelled', 'Speech WebSocket cancelled'));
        }
        try {
          ws.close(1000, 'aborted');
        } catch {
          ws.terminate();
        }
      };

      openOpts.signal?.addEventListener('abort', onAbort, { once: true });

      const connection: SocketConnection = {
        sendText(text: string): void {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(text);
          }
        },
        sendBinary(bytes: Uint8Array): void {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(bytes, { binary: true });
          }
        },
        close(code = 1000): void {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(code);
          }
        },
      };

      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        openOpts.signal?.removeEventListener('abort', onAbort);
        const code = res.statusCode ?? 502;
        res.resume();
        const err =
          code === 401 || code === 403
            ? new MiniBookError('speech-auth', `Edge WebSocket rejected handshake with HTTP ${code}`)
            : new MiniBookError('network', `Edge WebSocket unexpected HTTP ${code}`);
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          handlers.onError?.(err);
        }
        ws.terminate();
      });

      ws.on('open', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(connection);
        }
        handlers.onOpen?.();
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : Array.isArray(data)
                ? new Uint8Array(Buffer.concat(data))
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          handlers.onMessage({ kind: 'binary', bytes });
        } else {
          const text = typeof data === 'string' ? data : data.toString('utf8');
          handlers.onMessage({ kind: 'text', text });
        }
      });

      ws.on('close', (code, reasonBuf) => {
        clearTimeout(timer);
        openOpts.signal?.removeEventListener('abort', onAbort);
        const reason = reasonBuf && reasonBuf.length > 0 ? reasonBuf.toString('utf8') : undefined;
        handlers.onClose(reason !== undefined ? { code, reason } : { code });
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        openOpts.signal?.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(
            new MiniBookError(
              'network',
              err instanceof Error ? err.message : 'Speech WebSocket error',
              { cause: err },
            ),
          );
        } else {
          handlers.onError?.(err);
        }
      });
    });
  };
}
