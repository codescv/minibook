/**
 * HTTP 200 / 206 / 304 / 416 file responder using `fs.createReadStream({ start, end })`
 * with exact `Content-Length` and `ETag` (`ARCHITECTURE.md` §3.1, §3.3, §7.1).
 */
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

export type ParsedByteRange =
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.epub': 'application/epub+zip',
  '.azw3': 'application/vnd.amazon.mobi8-ebook',
  '.azw': 'application/x-mobipocket-ebook',
  '.mobi': 'application/x-mobipocket-ebook',
  '.prc': 'application/x-mobipocket-ebook',
  '.fb2': 'application/x-fictionbook+xml',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function inferMimeFromPath(filePath: string, fallback = 'application/octet-stream'): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

export function parseRangeHeader(
  rangeHeader: string | undefined | null,
  totalSize: number,
): ParsedByteRange {
  if (!rangeHeader || !rangeHeader.trim()) {
    return { kind: 'none' };
  }
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return { kind: 'none' };
  }
  const spec = trimmed.slice('bytes='.length).trim();
  // RFC 9110 §14.2: multi-range requests fall back to full 200 representation
  if (spec.includes(',')) {
    return { kind: 'none' };
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) {
    return { kind: 'unsatisfiable' };
  }
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) {
    return { kind: 'unsatisfiable' };
  }
  if (totalSize <= 0) {
    return { kind: 'unsatisfiable' };
  }

  if (!rawStart) {
    const suffixLen = Number.parseInt(rawEnd!, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, totalSize - suffixLen);
    return { kind: 'ok', start, end: totalSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
    return { kind: 'unsatisfiable' };
  }

  if (!rawEnd) {
    return { kind: 'ok', start, end: totalSize - 1 };
  }

  const parsedEnd = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) {
    return { kind: 'unsatisfiable' };
  }
  return { kind: 'ok', start, end: Math.min(totalSize - 1, parsedEnd) };
}

function matchesIfNoneMatch(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch || !ifNoneMatch.trim()) return false;
  const cleanTarget = etag.replace(/^W\//i, '').trim();
  for (const part of ifNoneMatch.split(',')) {
    const token = part.trim();
    if (token === '*') return true;
    if (token.replace(/^W\//i, '').trim() === cleanTarget) return true;
  }
  return false;
}

export function serveFileWithRange(params: {
  readonly method: 'GET' | 'HEAD';
  readonly filePath: string;
  readonly rangeHeader?: string | undefined;
  readonly ifNoneMatchHeader?: string | undefined;
  readonly contentType?: string | undefined;
  readonly etagSeed?: string | undefined;
  readonly cacheControl?: string | undefined;
}): Response {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(params.filePath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!st.isFile()) {
    return new Response('Not found', { status: 404 });
  }

  const totalSize = st.size;
  const etag = params.etagSeed
    ? `"${params.etagSeed}-${totalSize}"`
    : `"${totalSize}-${Math.trunc(st.mtimeMs)}"`;
  const contentType = params.contentType ?? inferMimeFromPath(params.filePath);
  const cacheControl = params.cacheControl ?? 'private, max-age=3600';

  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
    ETag: etag,
    'Cache-Control': cacheControl,
  };

  if (!params.rangeHeader && matchesIfNoneMatch(params.ifNoneMatchHeader, etag)) {
    return new Response(null, { status: 304, headers: baseHeaders });
  }

  const range = parseRangeHeader(params.rangeHeader, totalSize);
  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes */${totalSize}`,
      },
    });
  }

  const status = range.kind === 'ok' ? 206 : 200;
  const start = range.kind === 'ok' ? range.start : 0;
  const end = range.kind === 'ok' ? range.end : Math.max(0, totalSize - 1);
  const contentLength = totalSize === 0 ? 0 : end - start + 1;

  const headers: Record<string, string> = {
    ...baseHeaders,
    'Content-Length': String(contentLength),
  };
  if (range.kind === 'ok') {
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`;
  }

  if (params.method === 'HEAD' || contentLength === 0) {
    return new Response(null, { status, headers });
  }

  const nodeStream = createReadStream(params.filePath, { start, end });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status, headers });
}
