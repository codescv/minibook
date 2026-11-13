/**
 * Starts the MiniBook loopback HTTP server bound strictly to `127.0.0.1` (`ARCHITECTURE.md` §3.1, §12).
 */
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { createServerApp } from './app.js';
import { createNodeHostContext, type NodeHostContext, type NodeHostOptions } from './context.js';

export interface StartServerOptions extends NodeHostOptions {
  /** Port on `127.0.0.1`; `0` (default) picks an ephemeral free port. */
  readonly port?: number;
  readonly webRootDir?: string;
  readonly extraAllowedOrigins?: readonly string[];
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly app: Hono;
  readonly context: NodeHostContext;
  readonly server: ServerType;
  close(): Promise<void>;
}

function defaultWebRootDir(): string | undefined {
  const candidates = [
    new URL('./web', import.meta.url),
    new URL('../web', import.meta.url),
    new URL('../../dist/web', import.meta.url),
  ];
  for (const url of candidates) {
    const p = fileURLToPath(url);
    if (existsSync(p) && existsSync(`${p}/index.html`)) return p;
  }
  return undefined;
}

export async function startServer(options?: StartServerOptions): Promise<RunningServer> {
  const context = createNodeHostContext(options);
  const webRootDir = options?.webRootDir ?? defaultWebRootDir();
  const app = createServerApp(context, {
    ...(webRootDir ? { webRootDir } : {}),
    ...(options?.extraAllowedOrigins ? { extraAllowedOrigins: options.extraAllowedOrigins } : {}),
  });

  const requestedPort = options?.port ?? 0;

  let resolvedAddress: AddressInfo | undefined;
  const server = await new Promise<ServerType>((resolvePromise, rejectPromise) => {
    const s = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: requestedPort,
      },
      (info) => {
        resolvedAddress = info as AddressInfo;
        resolvePromise(s);
      },
    );
    s.once('error', rejectPromise);
  });

  const port = resolvedAddress?.port ?? (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    app,
    context,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
      await context.dispose();
    },
  };
}
