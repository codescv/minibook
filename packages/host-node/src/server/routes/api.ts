/**
 * Typed REST + binary Range API routes (`/api/*`, `ARCHITECTURE.md` §3.1, §12).
 */
import {
  MiniBookError,
  sanitizeReadableBookFileName,
  type AppSettings,
  type BookmarkInput,
  type ModelDownloadSource,
  type SavedPosition,
  type SpeechModelId,
  type SpeechModelVariant,
  type SynthRequest,
  type WordMark,
} from '@minibook/core';
import { Hono, type Context } from 'hono';
import type { CommitImportRequestWire } from '../../shared/routes.js';
import { errorEnvelope, okEnvelope } from '../../shared/wire.js';
import type { NodeHostContext } from '../context.js';
import { serveFileWithRange } from '../range-file.js';

function jsonSuccess<T>(c: Context, data: T) {
  return c.json(okEnvelope(data), 200);
}

function jsonFailure(c: Context, err: unknown) {
  const { status, body } = errorEnvelope(err);
  return c.json(body, status);
}

export function createApiRoutes(ctx: NodeHostContext): Hono {
  const api = new Hono();

  // --- Info ---
  api.get('/info', (c) => jsonSuccess(c, ctx.info));

  // --- Library ---
  api.get('/library', (c) => {
    try {
      return jsonSuccess(c, ctx.booksRepo.list());
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/library/:id', (c) => {
    try {
      const id = c.req.param('id');
      const rec = ctx.booksRepo.get(id);
      if (!rec) {
        return jsonSuccess(c, null);
      }
      const { fileExt: _ext, ...detail } = rec;
      return jsonSuccess(c, detail);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.delete('/library/:id', (c) => {
    try {
      const id = c.req.param('id');
      ctx.booksRepo.remove(id);
      ctx.storage.removeBookFiles(id);
      ctx.emit({ type: 'library-changed', bookId: id });
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/library/:id/finished', async (c) => {
    try {
      const id = c.req.param('id');
      const body = (await c.req.json()) as { readonly finished?: unknown };
      if (typeof body?.finished !== 'boolean') {
        throw new MiniBookError('invalid-argument', 'Boolean "finished" field is required');
      }
      if (!ctx.booksRepo.setFinished(id, body.finished)) {
        throw new MiniBookError('not-found', `Book not found: ${id}`);
      }
      ctx.emit({ type: 'library-changed', bookId: id });
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/library/:id/opened', async (c) => {
    try {
      const id = c.req.param('id');
      const body = (await c.req.json().catch(() => ({}))) as { readonly openedAt?: unknown };
      const openedAt = typeof body?.openedAt === 'number' ? body.openedAt : Date.now();
      ctx.booksRepo.markOpened(id, openedAt);
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- Book import staging, derived streams, commit & abort ---
  api.post('/books', async (c) => {
    try {
      const queryName = c.req.query('name');
      const headerName = c.req.header('x-minibook-filename');
      const fileName = queryName || headerName || 'book.epub';
      const stream = c.req.raw.body as ReadableStream<Uint8Array> | null;
      const staged = await ctx.storage.stageStream(fileName, stream);
      return jsonSuccess(c, {
        ticketId: staged.ticketId,
        bookId: staged.bookId,
        size: staged.size,
      });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/books/tickets/:ticketId/derived', async (c) => {
    try {
      const ticketId = c.req.param('ticketId');
      const name = c.req.query('name') ?? 'text.bin';
      const ab = await c.req.arrayBuffer();
      const bytes = ctx.storage.appendDerived(ticketId, name, new Uint8Array(ab));
      return jsonSuccess(c, { bytes });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/books/tickets/:ticketId/commit', async (c) => {
    try {
      const ticketId = c.req.param('ticketId');
      const body = (await c.req.json()) as CommitImportRequestWire;
      if (!body || !body.meta || !body.index) {
        throw new MiniBookError('invalid-argument', 'Missing meta or index in commit payload');
      }
      const cover =
        body.cover && typeof body.cover.base64 === 'string' && body.cover.base64.length > 0
          ? {
              mime: body.cover.mime || 'image/jpeg',
              bytes: new Uint8Array(Buffer.from(body.cover.base64, 'base64')),
            }
          : null;
      const overrideId =
        typeof body.bookId === 'string' && /^b_[a-f0-9]{16,64}$/i.test(body.bookId)
          ? body.bookId
          : undefined;
      const book = ctx.commitStagedBook(
        ticketId,
        {
          meta: body.meta,
          index: body.index,
          cover,
        },
        overrideId,
      );
      return jsonSuccess(c, book);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.delete('/books/tickets/:ticketId', (c) => {
    try {
      const ticketId = c.req.param('ticketId');
      ctx.storage.abortTicket(ticketId);
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- Binary Range serving (`/api/books/:id/file`, `/api/books/:id/download` & `/api/books/:id/cover`) ---
  api.on(['GET', 'HEAD'], '/books/:id/download', async (c) => {
    const id = c.req.param('id');
    const rec = ctx.booksRepo.get(id);
    if (!rec) {
      return new Response('Book not found', { status: 404 });
    }
    const filePath = ctx.storage.resolveBookFilePath(id, rec.fileExt, 'book');
    if (!filePath) {
      return new Response('Book file not found', { status: 404 });
    }
    const readableName = sanitizeReadableBookFileName(
      rec.title || rec.fileName,
      rec.fileExt,
    );
    const asciiFallback = readableName
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_');
    const encodedName = encodeURIComponent(readableName);
    const resp = await serveFileWithRange({
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      filePath,
      rangeHeader: c.req.header('range'),
      ifNoneMatchHeader: c.req.header('if-none-match'),
      etagSeed: `${id}-download`,
      cacheControl: 'private, max-age=0, must-revalidate',
    });
    const headers = new Headers(resp.headers);
    headers.set(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
    );
    return new Response(resp.body, {
      status: resp.status,
      headers,
    });
  });

  api.on(['GET', 'HEAD'], '/books/:id/file', (c) => {
    const id = c.req.param('id');
    const partParam = c.req.query('part');
    const part: 'book' | 'text' = partParam === 'text' ? 'text' : 'book';
    const rec = ctx.booksRepo.get(id);
    if (!rec) {
      return new Response('Book not found', { status: 404 });
    }
    const filePath = ctx.storage.resolveBookFilePath(id, rec.fileExt, part);
    if (!filePath) {
      return new Response('Book file not found', { status: 404 });
    }
    return serveFileWithRange({
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      filePath,
      rangeHeader: c.req.header('range'),
      ifNoneMatchHeader: c.req.header('if-none-match'),
      etagSeed: `${id}-${part}`,
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  api.on(['GET', 'HEAD'], '/books/:id/cover', (c) => {
    const id = c.req.param('id');
    const rec = ctx.booksRepo.get(id);
    if (!rec || !rec.hasCover) {
      return new Response('Cover not found', { status: 404 });
    }
    const coverPath = ctx.storage.resolveCoverPath(id, rec.coverMime);
    if (!coverPath) {
      return new Response('Cover not found', { status: 404 });
    }
    return serveFileWithRange({
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      filePath: coverPath,
      rangeHeader: c.req.header('range'),
      ifNoneMatchHeader: c.req.header('if-none-match'),
      ...(rec.coverMime ? { contentType: rec.coverMime } : {}),
      etagSeed: `${id}-cover`,
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  // --- State (positions & bookmarks) ---
  api.get('/books/:id/position', (c) => {
    try {
      const id = c.req.param('id');
      return jsonSuccess(c, ctx.stateRepo.getPosition(id));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.put('/books/:id/position', async (c) => {
    try {
      const id = c.req.param('id');
      const pos = (await c.req.json()) as SavedPosition;
      if (
        !pos ||
        typeof pos.section !== 'number' ||
        typeof pos.offset !== 'number' ||
        typeof pos.fraction !== 'number'
      ) {
        throw new MiniBookError('invalid-argument', 'Invalid SavedPosition payload');
      }
      ctx.stateRepo.savePosition(id, pos);
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/books/:id/bookmarks', (c) => {
    try {
      const id = c.req.param('id');
      return jsonSuccess(c, ctx.stateRepo.listBookmarks(id));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/books/:id/bookmarks', async (c) => {
    try {
      const id = c.req.param('id');
      const input = (await c.req.json()) as BookmarkInput;
      if (
        !input ||
        typeof input.section !== 'number' ||
        typeof input.offset !== 'number' ||
        typeof input.fraction !== 'number'
      ) {
        throw new MiniBookError('invalid-argument', 'Invalid BookmarkInput payload');
      }
      return jsonSuccess(c, ctx.stateRepo.addBookmark(id, input));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.delete('/books/:id/bookmarks/:bookmarkId', (c) => {
    try {
      const id = c.req.param('id');
      const bookmarkId = c.req.param('bookmarkId');
      ctx.stateRepo.removeBookmark(id, bookmarkId);
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- Settings, Secrets & Storage ---
  api.get('/settings', (c) => {
    try {
      return jsonSuccess(c, ctx.settingsRepo.get());
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.patch('/settings', async (c) => {
    try {
      const patch = (await c.req.json()) as Partial<AppSettings>;
      return jsonSuccess(c, ctx.settingsRepo.update(patch ?? {}));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.put('/secrets/:name', async (c) => {
    try {
      const name = c.req.param('name');
      const body = (await c.req.json()) as { readonly value?: string | null };
      const val = body?.value ?? null;
      ctx.secrets.set(name, val);
      ctx.recordSecretName(name, Boolean(val && val.length > 0));
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/secrets/:name', (c) => {
    try {
      const name = c.req.param('name');
      return jsonSuccess(c, { exists: ctx.secrets.has(name) });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/storage/usage', (c) => {
    try {
      return jsonSuccess(c, {
        booksBytes: ctx.storage.totalBooksBytes(),
        speechCacheBytes: ctx.synth.cacheSize(),
        modelsBytes: ctx.models.totalBytes(),
      });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- External browser opening ---
  api.post('/files/open-external', async (c) => {
    try {
      const body = (await c.req.json()) as { readonly url?: unknown };
      if (typeof body?.url !== 'string' || !body.url.trim()) {
        throw new MiniBookError('invalid-argument', 'Missing external URL');
      }
      await ctx.openExternal(body.url.trim());
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- Speech synthesis & audio cache ---
  api.post('/speech/synthesize', async (c) => {
    try {
      const req = (await c.req.json()) as SynthRequest;
      const res = await ctx.synth.synthesize(req, c.req.raw.signal);
      return jsonSuccess(c, res);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/speech/voices', async (c) => {
    try {
      const engine = c.req.query('engine');
      if (engine !== 'edge' && engine !== 'openai' && engine !== 'qwen') {
        throw new MiniBookError('invalid-argument', 'Query param engine must be "edge", "openai", or "qwen"');
      }
      const voices = await ctx.synth.listRemoteVoices(engine, c.req.raw.signal);
      return jsonSuccess(c, voices);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.on(['GET', 'HEAD'], '/speech/audio/:key', (c) => {
    const key = c.req.param('key');
    const cached = ctx.synth.getCachedAudio(key);
    if (!cached) {
      return new Response('Speech audio not found', { status: 404 });
    }
    return serveFileWithRange({
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      filePath: cached.filePath,
      rangeHeader: c.req.header('range'),
      ifNoneMatchHeader: c.req.header('if-none-match'),
      contentType: cached.mime,
      etagSeed: `speech-${cached.key}`,
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  api.post('/speech/cache', async (c) => {
    try {
      const body = (await c.req.json()) as {
        readonly key?: unknown;
        readonly mime?: unknown;
        readonly durationMs?: unknown;
        readonly marks?: unknown;
        readonly audioBase64?: unknown;
      };
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      if (!/^[a-f0-9]{16,64}$/i.test(key)) {
        throw new MiniBookError('invalid-argument', 'Invalid speech cache key');
      }
      const mime = body?.mime === 'audio/wav' || body?.mime === 'audio/mpeg' ? body.mime : null;
      if (!mime) {
        throw new MiniBookError('invalid-argument', 'Speech cache mime must be audio/wav or audio/mpeg');
      }
      if (typeof body?.audioBase64 !== 'string' || body.audioBase64.length === 0) {
        throw new MiniBookError('invalid-argument', 'audioBase64 is required');
      }
      const audio = new Uint8Array(Buffer.from(body.audioBase64, 'base64'));
      const MAX_CLIENT_AUDIO_BYTES = 32 * 1024 * 1024;
      if (audio.byteLength === 0 || audio.byteLength > MAX_CLIENT_AUDIO_BYTES) {
        throw new MiniBookError(
          audio.byteLength === 0 ? 'invalid-argument' : 'too-large',
          `Speech audio must be 1..${MAX_CLIENT_AUDIO_BYTES} bytes`,
        );
      }
      const durationMs =
        typeof body.durationMs === 'number' && Number.isFinite(body.durationMs)
          ? body.durationMs
          : undefined;
      const marks = Array.isArray(body.marks) ? (body.marks as readonly WordMark[]) : undefined;

      const stored = ctx.synth.putCachedAudio({
        key,
        audio,
        mime,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(marks !== undefined ? { marks } : {}),
      });
      return jsonSuccess(c, {
        ref: `/api/speech/audio/${stored.key}`,
        mime: stored.mime,
        ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
        ...(stored.marks !== undefined ? { marks: stored.marks } : {}),
        synthMs: 0,
        bytes: stored.bytes,
        cached: false,
      });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.delete('/speech/cache', (c) => {
    try {
      ctx.synth.clearCache();
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.get('/speech/cache/size', (c) => {
    try {
      return jsonSuccess(c, { bytes: ctx.synth.cacheSize() });
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  // --- On-device neural speech models (`/api/models/*`) ---
  api.get('/models/:id', (c) => {
    try {
      const id = c.req.param('id') as SpeechModelId;
      return jsonSuccess(c, ctx.models.status(id));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/models/:id/download', async (c) => {
    try {
      const id = c.req.param('id') as SpeechModelId;
      const body = (await c.req.json().catch(() => ({}))) as {
        readonly variant?: unknown;
        readonly voices?: unknown;
        readonly source?: unknown;
        readonly mirrorBaseUrl?: unknown;
      };
      const variant: SpeechModelVariant | undefined =
        body?.variant === 'onnx-fp32' || body?.variant === 'onnx-q8' ? body.variant : undefined;
      const voices = Array.isArray(body?.voices)
        ? body.voices.filter((v): v is string => typeof v === 'string')
        : undefined;
      const source: ModelDownloadSource | undefined =
        body?.source === 'auto' ||
        body?.source === 'huggingface' ||
        body?.source === 'hf-mirror' ||
        body?.source === 'custom'
          ? body.source
          : undefined;
      const mirrorBaseUrl: string | null | undefined =
        body?.mirrorBaseUrl === null || typeof body?.mirrorBaseUrl === 'string'
          ? body.mirrorBaseUrl
          : undefined;
      const status = await ctx.models.download(id, {
        ...(variant !== undefined ? { variant } : {}),
        ...(voices !== undefined ? { voices } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(mirrorBaseUrl !== undefined ? { mirrorBaseUrl } : {}),
      });
      return jsonSuccess(c, status);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.post('/models/:id/pause', async (c) => {
    try {
      const id = c.req.param('id') as SpeechModelId;
      return jsonSuccess(c, await ctx.models.pause(id));
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.delete('/models/:id', async (c) => {
    try {
      const id = c.req.param('id') as SpeechModelId;
      await ctx.models.remove(id);
      return jsonSuccess(c, null);
    } catch (err) {
      return jsonFailure(c, err);
    }
  });

  api.on(['GET', 'HEAD'], '/models/:id/file/*', (c) => {
    const id = c.req.param('id') as SpeechModelId;
    const reqPath = new URL(c.req.url, 'http://127.0.0.1').pathname;
    const marker = '/file/';
    const idx = reqPath.indexOf(marker);
    if (idx < 0) {
      return new Response('Model file not found', { status: 404 });
    }
    let relPath: string;
    try {
      relPath = decodeURIComponent(reqPath.slice(idx + marker.length));
    } catch {
      return new Response('Invalid path encoding', { status: 400 });
    }
    let filePath: string | null = null;
    try {
      filePath = ctx.models.resolveModelFilePath(id, relPath);
    } catch {
      return new Response('Invalid model id', { status: 400 });
    }
    if (!filePath) {
      return new Response('Model file not found', { status: 404 });
    }
    return serveFileWithRange({
      method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
      filePath,
      rangeHeader: c.req.header('range'),
      ifNoneMatchHeader: c.req.header('if-none-match'),
      contentType: 'application/octet-stream',
      etagSeed: `model-${id}-${relPath}`,
      cacheControl: 'private, max-age=31536000, immutable',
    });
  });

  return api;
}
