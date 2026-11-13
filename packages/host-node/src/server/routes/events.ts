/**
 * Server-Sent Events (`/api/events`) streaming `HostEvent` JSON objects (`ARCHITECTURE.md` §3.1).
 */
import { Hono } from 'hono';
import type { NodeHostContext } from '../context.js';

const HEARTBEAT_MS = 20_000;

export function createEventsRoutes(ctx: NodeHostContext): Hono {
  const router = new Hono();

  router.get('/events', (c) => {
    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const sendRaw = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
            cleanup?.();
          }
        };

        sendRaw(': connected\n\n');

        const unsub = ctx.subscribe((event) => {
          sendRaw(`data: ${JSON.stringify(event)}\n\n`);
        });

        const timer = setInterval(() => {
          sendRaw(': ping\n\n');
        }, HEARTBEAT_MS);
        timer.unref?.();

        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          unsub();
          try {
            controller.close();
          } catch {
            // ignore already closed
          }
        };

        c.req.raw.signal?.addEventListener('abort', () => cleanup?.(), { once: true });
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return router;
}
