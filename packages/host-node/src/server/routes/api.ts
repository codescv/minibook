/**
 * Typed REST + binary Range API routes (`/api/*`, `ARCHITECTURE.md` §3.1, §12).
 */
import {
  MiniBookError,
  type AppSettings,
  type BookmarkInput,
  type SavedPosition,
  type SynthRequest,
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

  // --- Binary Range serving (`/api/books/:id/file` & `/api/books/:id/cover`) ---
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

  return api;
}
