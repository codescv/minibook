/**
 * Loopback DNS-rebinding (`Host`) and CSRF (`Origin` + `Content-Type`) guard middleware
 * (`ARCHITECTURE.md` §3.1, §12, §13).
 *
 * The MiniBook Node server binds strictly to `127.0.0.1` without an auth token and can
 * make outbound speech requests, so every request must carry a loopback `Host` header,
 * and every mutating request must carry a loopback `Origin` (when present) and an
 * expected `Content-Type`.
 */
import type { MiddlewareHandler } from 'hono';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function stripPortFromHost(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    return closeIdx >= 0 ? trimmed.slice(0, closeIdx + 1) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // In-process `app.request('/api/...')` in tests may omit Host
  return LOOPBACK_HOSTS.has(stripPortFromHost(hostHeader));
}

export function isAllowedLoopbackOrigin(
  originHeader: string | undefined,
  extraAllowedOrigins?: ReadonlySet<string>,
): boolean {
  if (!originHeader) return true;
  if (extraAllowedOrigins?.has(originHeader)) return true;
  try {
    const u = new URL(originHeader);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BINARY_UPLOAD_CONTENT_TYPES = [
  'application/octet-stream',
  'application/epub+zip',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.mobi8-ebook',
  'application/x-fictionbook+xml',
  'application/zip',
];

function isBinaryUploadRoute(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  if (pathname === '/api/books') return true;
  return /^\/api\/books\/tickets\/[^/]+\/derived$/.test(pathname);
}

export interface LoopbackGuardOptions {
  readonly extraAllowedOrigins?: readonly string[];
}

export function createLoopbackGuard(options?: LoopbackGuardOptions): MiddlewareHandler {
  const extraSet = options?.extraAllowedOrigins
    ? new Set(options.extraAllowedOrigins)
    : undefined;

  return async (c, next) => {
    const hostHeader = c.req.header('host');
    if (!isLoopbackHostHeader(hostHeader)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid-argument',
            message: `Rejected non-loopback Host header: ${hostHeader}`,
          },
        },
        403,
      );
    }

    // Sec-Fetch-Site cross-site guard for modern browsers (blocks cross-site GET/SSE/POST alike)
    const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
    if (secFetchSite === 'cross-site') {
      const origin = c.req.header('origin');
      if (!origin || !isAllowedLoopbackOrigin(origin, extraSet)) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid-argument',
              message: 'Rejected cross-site browser request',
            },
          },
          403,
        );
      }
    }

    const method = c.req.method.toUpperCase();
    const origin = c.req.header('origin');
    if (origin !== undefined && !isAllowedLoopbackOrigin(origin, extraSet)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid-argument',
            message: `Rejected cross-origin request from Origin: ${origin}`,
          },
        },
        403,
      );
    }

    if (MUTATING_METHODS.has(method) && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      const contentLength = c.req.header('content-length');
      const transferEncoding = c.req.header('transfer-encoding');
      const hasBody =
        (contentLength !== undefined && contentLength !== '0') ||
        transferEncoding !== undefined;

      if (hasBody) {
        const ct = (c.req.header('content-type') ?? '').toLowerCase();
        const pathname = new URL(c.req.url, 'http://127.0.0.1').pathname;
        const allowed = isBinaryUploadRoute(method, pathname)
          ? BINARY_UPLOAD_CONTENT_TYPES.some((prefix) => ct.startsWith(prefix))
          : ct.startsWith('application/json');

        if (!allowed) {
          return c.json(
            {
              ok: false,
              error: {
                code: 'invalid-argument',
                message: `Unsupported Content-Type "${ct}" for ${method} ${pathname}`,
              },
            },
            415,
          );
        }
      }
    }

    return next();
  };
}
