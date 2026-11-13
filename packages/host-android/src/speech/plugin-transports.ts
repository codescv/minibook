/**
 * Adapts `MiniBookPlugin.http` and `MiniBookPlugin.socket` into `@minibook/core`'s
 * `HttpTransport` and `SocketTransport` (`ARCHITECTURE.md` §3.2, §8.4).
 *
 * Listeners for `socket-*` events are attached BEFORE calling `plugin.socket.open`
 * so fast handshake events can never race ahead of JS subscription.
 */
import {
  MiniBookError,
  type HttpTransport,
  type SocketConnection,
  type SocketHandlers,
  type SocketOpenOptions,
  type SocketTransport,
  type TransportHttpRequest,
  type TransportHttpResponse,
} from '@minibook/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { MiniBookPlugin } from '../plugin-types.js';
import { base64ToBytes, bytesToBase64 } from '../storage/base64.js';

let socketSeq = 0;

export function createPluginHttpTransport(plugin: MiniBookPlugin): HttpTransport {
  return async (req: TransportHttpRequest): Promise<TransportHttpResponse> => {
    if (req.signal?.aborted) {
      throw new MiniBookError('cancelled', 'Native HTTP request aborted');
    }

    let bodyBase64: string | undefined;
    if (req.body !== undefined) {
      const bytes =
        typeof req.body === 'string' ? new TextEncoder().encode(req.body) : req.body;
      bodyBase64 = bytesToBase64(bytes);
    }

    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (!req.signal) return;
      req.signal.addEventListener(
        'abort',
        () => reject(new MiniBookError('cancelled', 'Native HTTP request cancelled')),
        { once: true },
      );
    });

    try {
      const callPromise = plugin.http.request({
        url: req.url,
        method: req.method,
        ...(req.headers ? { headers: req.headers } : {}),
        ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
        timeoutMs: req.timeoutMs ?? 30_000,
      });

      const res = req.signal
        ? await Promise.race([callPromise, abortPromise])
        : await callPromise;

      const normalizedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers ?? {})) {
        normalizedHeaders[k.toLowerCase()] = v;
      }

      return {
        status: res.status,
        headers: normalizedHeaders,
        body: base64ToBytes(res.bodyBase64),
      };
    } catch (err) {
      if (err instanceof MiniBookError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/speech-auth|401|403|missing secret/i.test(msg)) {
        throw new MiniBookError('speech-auth', msg, { cause: err });
      }
      throw new MiniBookError('network', msg, { cause: err });
    }
  };
}

export function createPluginSocketTransport(plugin: MiniBookPlugin): SocketTransport {
  return async (opts: SocketOpenOptions, handlers: SocketHandlers): Promise<SocketConnection> => {
    if (opts.signal?.aborted) {
      throw new MiniBookError('cancelled', 'Native WebSocket aborted before open');
    }

    const id = `mb_ws_${++socketSeq}_${Date.now()}`;
    const handles: PluginListenerHandle[] = [];
    let closed = false;
    let opened = false;

    const cleanupHandles = async () => {
      while (handles.length > 0) {
        const h = handles.pop();
        if (h) {
          await h.remove().catch(() => undefined);
        }
      }
    };

    const connection: SocketConnection = {
      sendText(text: string): void {
        if (closed) return;
        void plugin.socket.send({ id, text }).catch((err) => {
          handlers.onError?.(err);
        });
      },
      sendBinary(bytes: Uint8Array): void {
        if (closed) return;
        void plugin.socket
          .send({ id, base64: bytesToBase64(bytes) })
          .catch((err) => {
            handlers.onError?.(err);
          });
      },
      close(code = 1000): void {
        if (closed) return;
        closed = true;
        void plugin.socket.close({ id, code }).catch(() => undefined);
        void cleanupHandles();
      },
    };

    return new Promise<SocketConnection>((resolvePromise, rejectPromise) => {
      let settled = false;
      const timeoutMs = opts.timeoutMs ?? 20_000;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          connection.close(1000);
          rejectPromise(new MiniBookError('network', `Native WebSocket timed out (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        connection.close(1000);
        if (!settled) {
          settled = true;
          rejectPromise(new MiniBookError('cancelled', 'Native WebSocket cancelled'));
        }
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          handles.push(
            await plugin.addListener('socket-open', (ev) => {
              if (ev.id !== id) return;
              opened = true;
              clearTimeout(timer);
              if (!settled) {
                settled = true;
                resolvePromise(connection);
              }
              handlers.onOpen?.();
            }),
          );

          handles.push(
            await plugin.addListener('socket-message', (ev) => {
              if (ev.id !== id) return;
              if (ev.base64 !== undefined) {
                handlers.onMessage({ kind: 'binary', bytes: base64ToBytes(ev.base64) });
              } else if (ev.text !== undefined) {
                handlers.onMessage({ kind: 'text', text: ev.text });
              }
            }),
          );

          handles.push(
            await plugin.addListener('socket-close', (ev) => {
              if (ev.id !== id) return;
              closed = true;
              clearTimeout(timer);
              opts.signal?.removeEventListener('abort', onAbort);
              void cleanupHandles();
              if (!settled) {
                settled = true;
                const code = ev.code ?? 1006;
                rejectPromise(
                  new MiniBookError(
                    code === 401 || code === 403 ? 'speech-auth' : 'network',
                    ev.reason || `Native WebSocket closed before open (code ${code})`,
                  ),
                );
                return;
              }
              handlers.onClose(
                ev.reason !== undefined ? { code: ev.code, reason: ev.reason } : { code: ev.code },
              );
            }),
          );

          handles.push(
            await plugin.addListener('socket-error', (ev) => {
              if (ev.id !== id) return;
              clearTimeout(timer);
              const isAuth = /401|403|forbidden|unauthorized/i.test(ev.message);
              const err = new MiniBookError(
                isAuth ? 'speech-auth' : 'network',
                ev.message || 'Native WebSocket error',
              );
              if (!settled && !opened) {
                settled = true;
                closed = true;
                opts.signal?.removeEventListener('abort', onAbort);
                void cleanupHandles();
                rejectPromise(err);
              } else {
                handlers.onError?.(err);
              }
            }),
          );

          await plugin.socket.open({
            id,
            url: opts.url,
            ...(opts.headers ? { headers: opts.headers } : {}),
            timeoutMs,
          });
        } catch (err) {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          await cleanupHandles();
          if (!settled) {
            settled = true;
            const msg = err instanceof Error ? err.message : String(err);
            rejectPromise(
              new MiniBookError(
                /401|403|speech-auth/i.test(msg) ? 'speech-auth' : 'network',
                msg,
                { cause: err },
              ),
            );
          }
        }
      })();
    });
  };
}
