/**
 * Assembles the MiniBook Hono server application (`ARCHITECTURE.md` §3.1, §6.1, §12):
 *   - Loopback DNS-rebinding & CSRF guard (`createLoopbackGuard`)
 *   - SSE event stream (`/api/events`)
 *   - Typed JSON + HTTP 206 Range endpoints (`/api/*`)
 *   - Static SPA asset serving (`dist/web/*` with `index.html` fallback + strict CSP header)
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { Hono } from 'hono';
import type { NodeHostContext } from './context.js';
import { createLoopbackGuard } from './guard.js';
import { createApiRoutes } from './routes/api.js';
import { createEventsRoutes } from './routes/events.js';

/** App-level CSP (`ARCHITECTURE.md` §6.1 Layer 2). */
export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self' about:",
  "img-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "media-src 'self' blob:",
  "connect-src 'self' blob: data:",
].join('; ');

const STATIC_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export interface ServerAppOptions {
  readonly webRootDir?: string;
  readonly extraAllowedOrigins?: readonly string[];
}

export function createServerApp(ctx: NodeHostContext, options?: ServerAppOptions): Hono {
  const app = new Hono();

  app.use(
    '*',
    createLoopbackGuard(
      options?.extraAllowedOrigins ? { extraAllowedOrigins: options.extraAllowedOrigins } : undefined,
    ),
  );

  app.route('/api', createEventsRoutes(ctx));
  app.route('/api', createApiRoutes(ctx));

  const webRoot = options?.webRootDir ? resolve(options.webRootDir) : undefined;
  if (webRoot && existsSync(webRoot)) {
    app.get('*', (c) => {
      const reqPath = new URL(c.req.url, 'http://127.0.0.1').pathname;
      if (reqPath.startsWith('/api/')) {
        return c.notFound();
      }
      const cleanRel = normalize(reqPath)
        .replace(/^(\.\.(\/|\\|$))+/, '')
        .replace(/^[/\\]+/, '');
      const candidate = resolve(webRoot, cleanRel || 'index.html');
      if (candidate.startsWith(webRoot) && existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) {
            const ext = extname(candidate).toLowerCase();
            const contentType = STATIC_MIME[ext] ?? 'application/octet-stream';
            const body = readFileSync(candidate);
            return new Response(body, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                ...(ext === '.html'
                  ? {
                      'Cache-Control': 'no-cache',
                      'Content-Security-Policy': DESKTOP_CONTENT_SECURITY_POLICY,
                    }
                  : { 'Cache-Control': 'public, max-age=31536000, immutable' }),
              },
            });
          }
        } catch {
          // fall through to SPA index.html
        }
      }

      const spaIndex = join(webRoot, 'index.html');
      if (existsSync(spaIndex)) {
        return new Response(readFileSync(spaIndex), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Content-Security-Policy': DESKTOP_CONTENT_SECURITY_POLICY,
          },
        });
      }

      return c.notFound();
    });
  }

  return app;
}
