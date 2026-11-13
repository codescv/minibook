import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KOKORO_MODEL_ID,
  encodeMonoPcm16Wav,
  memoryByteSource,
  type HostEvent,
  type InspectedBook,
  type TxtBookIndex,
} from '@minibook/core';
import type { KokoroWorkerLike } from '../client/kokoro/kokoro-web-engine.js';
import type { KokoroWorkerRequest, KokoroWorkerResponse } from '../client/kokoro/kokoro.worker.js';
import { createRestPlatformHost } from '../client/rest-host.js';
import { ROUTES } from '../shared/routes.js';
import { DESKTOP_CONTENT_SECURITY_POLICY, createServerApp } from './app.js';
import { createNodeHostContext, type NodeHostContext } from './context.js';
import { startServer } from './start.js';

function makeSampleTxtInspected(title = 'A Tale of Two Cities'): InspectedBook {
  const meta = {
    title,
    authors: ['Charles Dickens'],
    language: 'en',
    identifier: 'id-dickens-1',
    format: 'txt' as const,
    direction: 'ltr' as const,
    fixedLayout: false,
  };
  const index: TxtBookIndex = {
    kind: 'txt',
    encoding: 'utf-8',
    usesDerivedText: true,
    meta,
    toc: [{ title: 'Chapter 1', locator: { section: 0, offset: 0 }, children: [] }],
    spine: [{ index: 0, linear: true, sizeHint: 1200 }],
    chapters: [
      {
        index: 0,
        title: 'Chapter 1',
        byteStart: 0,
        byteEnd: 512,
        charCount: 512,
        hasHeadingLine: true,
      },
    ],
  };
  const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  return {
    meta,
    cover: { mime: 'image/png', bytes: pngHeader },
    index,
  };
}

describe('@minibook/host-node server, SQLite, HTTP 206 Range & RestPlatformHost', () => {
  let tempDir: string;
  let ctx: NodeHostContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'minibook-host-node-test-'));
    ctx = createNodeHostContext({ dataDir: tempDir, appVersion: '0.1.0' });
  });

  afterEach(async () => {
    await ctx.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers every single route declared in the shared ROUTES table', () => {
    const app = createServerApp(ctx);
    const registered = new Set(
      app.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`),
    );
    for (const [routeName, spec] of Object.entries(ROUTES)) {
      const key = `${spec.method} ${spec.path}`;
      expect(registered.has(key), `Missing Hono handler for ROUTES.${routeName} (${key})`).toBe(true);
    }
  });

  it('enforces strict loopback Host, Origin, Sec-Fetch-Site, and Content-Type guards', async () => {
    const app = createServerApp(ctx);

    // DNS rebinding: non-loopback Host rejected
    const badHost = await app.request('http://127.0.0.1/api/info', {
      headers: { Host: 'attacker.example.com' },
    });
    expect(badHost.status).toBe(403);

    // Cross-origin CSRF rejected
    const badOrigin = await app.request('http://127.0.0.1/api/settings', {
      method: 'PATCH',
      headers: {
        Host: '127.0.0.1:4000',
        Origin: 'https://evil.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ justify: false }),
    });
    expect(badOrigin.status).toBe(403);

    // Cross-site GET via browser Sec-Fetch-Site rejected
    const crossSiteGet = await app.request('http://127.0.0.1/api/library', {
      headers: {
        Host: '127.0.0.1:4000',
        'Sec-Fetch-Site': 'cross-site',
      },
    });
    expect(crossSiteGet.status).toBe(403);

    // Form-encoded CSRF body rejected with 415
    const formPost = await app.request('http://127.0.0.1/api/settings', {
      method: 'PATCH',
      headers: {
        Host: '127.0.0.1:4000',
        Origin: 'http://127.0.0.1:4000',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': '9',
      },
      body: 'justify=0',
    });
    expect(formPost.status).toBe(415);

    // Valid loopback request succeeds
    const goodReq = await app.request('http://127.0.0.1/api/info', {
      headers: { Host: 'localhost:4000' },
    });
    expect(goodReq.status).toBe(200);
  });

  it('imports books with derived text.bin, serves exact 206 Partial Content & ETag, and persists state', async () => {
    const app = createServerApp(ctx);
    let rangeCallCount = 0;

    const inProcessFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      if (headers.has('range') && urlStr.includes('/file')) {
        rangeCallCount += 1;
      }
      return app.request(
        urlStr.startsWith('http') ? urlStr : `http://127.0.0.1${urlStr}`,
        init,
      );
    };

    const host = createRestPlatformHost({
      fetchImpl: inProcessFetch,
      enableSse: false,
    });

    // Create a 160 KiB book payload + 512-byte derived text.bin
    const bookBytes = new Uint8Array(160 * 1024);
    for (let i = 0; i < bookBytes.byteLength; i++) {
      bookBytes[i] = i & 0xff;
    }
    const derivedBytes = new Uint8Array(512);
    for (let i = 0; i < derivedBytes.byteLength; i++) {
      derivedBytes[i] = (i * 7) & 0xff;
    }

    const ticket = await host.library.beginImport({
      name: 'two-cities.txt',
      size: bookBytes.byteLength,
      bytes: memoryByteSource(bookBytes),
    });
    await ticket.putDerived('text.bin', derivedBytes.subarray(0, 256));
    await ticket.putDerived('text.bin', derivedBytes.subarray(256));

    const committed = await host.library.commitImport(ticket, makeSampleTxtInspected());
    expect(committed.title).toBe('A Tale of Two Cities');
    expect(committed.size).toBe(bookBytes.byteLength);
    expect(committed.hasCover).toBe(true);

    // Duplicate import returns existing book without duplicating row
    const dupTicket = await host.library.beginImport({
      name: 'two-cities-copy.txt',
      size: bookBytes.byteLength,
      bytes: memoryByteSource(bookBytes),
    });
    const dupCommitted = await host.library.commitImport(dupTicket, makeSampleTxtInspected('Duplicate'));
    expect(dupCommitted.id).toBe(committed.id);
    expect((await host.library.list()).length).toBe(1);

    // Direct HTTP 206 Range verification (exact Content-Length, Content-Range, ETag, 304, 416)
    const rangeResp = await app.request(
      `http://127.0.0.1/api/books/${committed.id}/file`,
      { headers: { Range: 'bytes=10-29' } },
    );
    expect(rangeResp.status).toBe(206);
    expect(rangeResp.headers.get('content-length')).toBe('20');
    expect(rangeResp.headers.get('content-range')).toBe(`bytes 10-29/${bookBytes.byteLength}`);
    const etag = rangeResp.headers.get('etag');
    expect(etag).toBeTruthy();
    const slice20 = new Uint8Array(await rangeResp.arrayBuffer());
    expect(slice20).toEqual(bookBytes.subarray(10, 30));

    // If-None-Match -> 304
    const cachedResp = await app.request(
      `http://127.0.0.1/api/books/${committed.id}/file`,
      { headers: { 'If-None-Match': etag! } },
    );
    expect(cachedResp.status).toBe(304);

    // Unsatisfiable Range -> 416
    const badRange = await app.request(
      `http://127.0.0.1/api/books/${committed.id}/file`,
      { headers: { Range: `bytes=${bookBytes.byteLength + 100}-${bookBytes.byteLength + 200}` } },
    );
    expect(badRange.status).toBe(416);

    // Derived text.bin Range read through RestPlatformHost.files.byteSource(id, 'text')
    const detail = await host.library.get(committed.id);
    expect(detail).not.toBeNull();
    const derivedSource = host.files.byteSource(committed.id, 'text');
    expect(derivedSource.size).toBe(512);
    const derivedSlice = await derivedSource.read(100, 50);
    expect(derivedSlice).toEqual(derivedBytes.subarray(100, 150));

    // Window coalescing check: 5 small reads inside the first 64 KiB window issue ONLY 1 HTTP Range call
    rangeCallCount = 0;
    const bookSource = host.files.byteSource(committed.id, 'book');
    for (const off of [0, 128, 1024, 4096, 32768]) {
      const part = await bookSource.read(off, 32);
      expect(part).toEqual(bookBytes.subarray(off, off + 32));
    }
    expect(rangeCallCount).toBe(1);

    // Cover route
    const coverResp = await app.request(`http://127.0.0.1/api/books/${committed.id}/cover`);
    expect(coverResp.status).toBe(200);
    expect(coverResp.headers.get('content-type')).toBe('image/png');

    // Reading positions & bookmarks
    expect(await host.state.getPosition(committed.id)).toBeNull();
    await host.state.savePosition(committed.id, {
      section: 0,
      offset: 420,
      fraction: 0.35,
      snippet: 'It was the best of times',
      updatedAt: 1700000000000,
    });
    const savedPos = await host.state.getPosition(committed.id);
    expect(savedPos?.offset).toBe(420);
    expect(savedPos?.fraction).toBeCloseTo(0.35);

    const bm1 = await host.state.addBookmark(committed.id, {
      section: 0,
      offset: 100,
      fraction: 0.08,
      label: 'The Period',
    });
    // Idempotent duplicate bookmark at same (section, offset)
    const bmDup = await host.state.addBookmark(committed.id, {
      section: 0,
      offset: 100,
      fraction: 0.08,
      label: 'The Period Updated',
    });
    expect(bmDup.id).toBe(bm1.id);
    expect((await host.state.listBookmarks(committed.id)).length).toBe(1);
    await host.state.removeBookmark(committed.id, bm1.id);
    expect((await host.state.listBookmarks(committed.id)).length).toBe(0);

    // Settings & mode-0600 secrets
    const updated = await host.settings.update({ theme: 'quiet', fontScale: 120 });
    expect(updated.theme).toBe('quiet');
    expect(updated.fontScale).toBe(120);

    expect(await host.settings.hasSecret('custom-speech-key')).toBe(false);
    await host.settings.setSecret('custom-speech-key', 'sk-secret-value');
    expect(await host.settings.hasSecret('custom-speech-key')).toBe(true);
    const secretFileMode = statSync(join(tempDir, 'secrets.json')).mode & 0o777;
    expect(secretFileMode).toBe(0o600);
    // Secret value never appears in settings JSON
    expect(JSON.stringify(await host.settings.get())).not.toContain('sk-secret-value');

    // Mark finished & remove
    await host.library.setFinished(committed.id, true);
    expect((await host.library.list())[0]?.finished).toBe(true);
    await host.library.remove(committed.id);
    expect(await host.library.list()).toEqual([]);
  });

  it('streams live HostEvents over /api/events SSE on a real loopback socket and imports local files', async () => {
    const running = await startServer({ dataDir: tempDir, port: 0 });
    try {
      const sampleFile = join(tempDir, 'cli-sample.txt');
      writeFileSync(sampleFile, 'Chapter 1\nIt was the best of times.\n', 'utf8');

      const received: HostEvent[] = [];
      const clientHost = createRestPlatformHost({
        baseUrl: running.url,
        enableSse: true,
      });
      const unsub = clientHost.subscribe((ev) => {
        received.push(ev);
      });

      // Give SSE connection a moment to establish
      await new Promise((r) => setTimeout(r, 40));

      const imported = await running.context.importLocalFile(sampleFile, {
        inspectImpl: async () => makeSampleTxtInspected('CLI Imported Book'),
      });
      expect(imported.title).toBe('CLI Imported Book');

      await new Promise((r) => setTimeout(r, 40));
      unsub();

      expect(received.some((e) => e.type === 'library-changed' && e.bookId === imported.id)).toBe(
        true,
      );
    } finally {
      await running.close();
    }
  });

  it('serves CSP wasm-unsafe-eval + worker-src, COOP/COEP/CORP on HTML/static/API/SSE, .wasm MIME, jailed model files, and /api/speech/cache', async () => {
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("'wasm-unsafe-eval'");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("worker-src 'self'");

    const webRoot = join(tempDir, 'web-root');
    mkdirSync(join(webRoot, 'ort'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><html><body>hi</body></html>');
    writeFileSync(join(webRoot, 'ort', 'ort-wasm-simd-threaded.asyncify.wasm'), new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

    // Seed a valid manifest-named model voice file AND a secret non-manifest file inside models dir
    const modelsDir = join(tempDir, 'models', KOKORO_MODEL_ID, 'voices');
    mkdirSync(modelsDir, { recursive: true });
    const fakeVoice = new Uint8Array(64).fill(0x2a);
    writeFileSync(join(modelsDir, 'zf_001.bin'), fakeVoice);
    writeFileSync(join(tempDir, 'models', KOKORO_MODEL_ID, 'secret.txt'), 'nope');

    const app = createServerApp(ctx, { webRootDir: webRoot });

    // HTML response
    const htmlResp = await app.request('http://127.0.0.1/');
    expect(htmlResp.status).toBe(200);
    expect(htmlResp.headers.get('content-security-policy')).toContain("'wasm-unsafe-eval'");
    expect(htmlResp.headers.get('content-security-policy')).toContain("worker-src 'self'");
    expect(htmlResp.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(htmlResp.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(htmlResp.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    // Static .wasm response
    const wasmResp = await app.request('http://127.0.0.1/ort/ort-wasm-simd-threaded.asyncify.wasm');
    expect(wasmResp.status).toBe(200);
    expect(wasmResp.headers.get('content-type')).toBe('application/wasm');
    expect(wasmResp.headers.get('cross-origin-embedder-policy')).toBe('require-corp');

    // API JSON response
    const apiResp = await app.request('http://127.0.0.1/api/info');
    expect(apiResp.status).toBe(200);
    expect(apiResp.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(apiResp.headers.get('cross-origin-embedder-policy')).toBe('require-corp');

    // SSE response
    const sseAbort = new AbortController();
    const sseResp = await app.request('http://127.0.0.1/api/events', { signal: sseAbort.signal });
    expect(sseResp.status).toBe(200);
    expect(sseResp.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(sseResp.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    sseAbort.abort();

    // Model file route: valid manifest file supports Range 206, non-manifest / traversal blocked with 404
    const voiceResp = await app.request(
      `http://127.0.0.1/api/models/${KOKORO_MODEL_ID}/file/voices/zf_001.bin`,
      { headers: { Range: 'bytes=0-15' } },
    );
    expect(voiceResp.status).toBe(206);
    expect(new Uint8Array(await voiceResp.arrayBuffer())).toEqual(fakeVoice.subarray(0, 16));

    const blockedSecret = await app.request(
      `http://127.0.0.1/api/models/${KOKORO_MODEL_ID}/file/secret.txt`,
    );
    expect(blockedSecret.status).toBe(404);

    const blockedTraversal = await app.request(
      `http://127.0.0.1/api/models/${KOKORO_MODEL_ID}/file/..%2F..%2Fminibook.sqlite`,
    );
    expect(blockedTraversal.status).toBe(404);

    // POST /api/speech/cache validation + RestPlatformHost Kokoro worker integration
    const badCacheKey = await app.request('http://127.0.0.1/api/speech/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: '../bad', mime: 'audio/wav', audioBase64: 'AAAA' }),
    });
    expect(badCacheKey.status).toBe(400);

    let workerRuns = 0;
    const fakeWorkerFactory = (): KokoroWorkerLike => {
      const msgListeners = new Set<(ev: MessageEvent<KokoroWorkerResponse>) => void>();
      return {
        addEventListener(type, fn) {
          if (type === 'message') msgListeners.add(fn as (ev: MessageEvent<KokoroWorkerResponse>) => void);
        },
        postMessage(msg: KokoroWorkerRequest) {
          if (msg.type === 'synth') {
            workerRuns += 1;
            const wav = encodeMonoPcm16Wav(new Float32Array(2400).fill(0.25), 24_000);
            const buf = wav.wav.slice().buffer;
            const resp: KokoroWorkerResponse = {
              type: 'synth-ok',
              id: msg.id,
              backend: 'wasm',
              wav: buf,
              durationMs: wav.durationMs,
              marks: [],
              synthMs: 42,
            };
            queueMicrotask(() => {
              for (const fn of msgListeners) {
                fn({ data: resp } as MessageEvent<KokoroWorkerResponse>);
              }
            });
          }
        },
        terminate() {},
      };
    };

    const inProcessFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return app.request(urlStr.startsWith('http') ? urlStr : `http://127.0.0.1${urlStr}`, init);
    };

    const host = createRestPlatformHost({
      fetchImpl: inProcessFetch,
      enableSse: false,
      kokoroWorkerFactory: fakeWorkerFactory,
    });

    const synth1 = await host.speech.synthesize({
      engine: 'kokoro',
      voiceId: 'zf_001',
      text: '你好。',
      lang: 'zh-CN',
      phonemeIds: [[73, 127, 172, 88, 108, 169, 4]],
      phonemeSpeeds: [1.1],
    });
    expect(workerRuns).toBe(1);
    expect(synth1.cached).toBe(false);
    expect(synth1.mime).toBe('audio/wav');

    const synth2 = await host.speech.synthesize({
      engine: 'kokoro',
      voiceId: 'zf_001',
      text: '你好。',
      lang: 'zh-CN',
      phonemeIds: [[73, 127, 172, 88, 108, 169, 4]],
      phonemeSpeeds: [1.1],
    });
    expect(workerRuns).toBe(1);
    expect(synth2.cached).toBe(true);
    expect(synth2.ref).toBe(synth1.ref);
  });
});
