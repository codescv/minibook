import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  KOKORO_MANIFEST,
  KOKORO_MODEL_ID,
  isAllowedModelRedirectUrl,
  type AppSettings,
  type HostEvent,
  type ResolvedKokoroDownloadFile,
} from '@minibook/core';
import { ModelStore } from './model-store.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFakeBytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = (i * 31 + seed) & 0xff;
  }
  return out;
}

describe('ModelStore downloader, mirror fallback, HTTP 206 resume & SHA-256 verification', () => {
  let tempDir: string;
  let settings: AppSettings;
  let events: HostEvent[];
  const serversToClose: Array<() => Promise<void>> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'minibook-model-store-'));
    settings = { ...DEFAULT_APP_SETTINGS };
    events = [];
  });

  afterEach(async () => {
    while (serversToClose.length > 0) {
      const fn = serversToClose.pop();
      if (fn) await fn();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startHttpFixture(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ readonly url: string; readonly port: number }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected numeric port');
    serversToClose.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    );
    return { url: `http://127.0.0.1:${addr.port}`, port: addr.port };
  }

  function makeTestManifest(modelBytes: Uint8Array, voiceBytes: Uint8Array): ResolvedKokoroDownloadFile[] {
    return [
      {
        path: 'onnx/model.onnx',
        size: modelBytes.byteLength,
        sha256: sha256Hex(modelBytes),
        repo: KOKORO_MANIFEST.onnx.repo,
        revision: KOKORO_MANIFEST.onnx.revision,
      },
      {
        path: 'voices/zf_001.bin',
        size: voiceBytes.byteLength,
        sha256: sha256Hex(voiceBytes),
        repo: KOKORO_MANIFEST.onnx.repo,
        revision: KOKORO_MANIFEST.onnx.revision,
      },
    ];
  }

  it('enforces HTTPS-only redirect allowlist by default', () => {
    expect(
      isAllowedModelRedirectUrl('https://cdn-lfs.hf.co/repos/kokoro/model.onnx'),
    ).toBe(true);
    expect(
      isAllowedModelRedirectUrl('https://hf-mirror.com/onnx-community/Kokoro/resolve/main/a'),
    ).toBe(true);
    expect(
      isAllowedModelRedirectUrl('http://127.0.0.1:8080/model.onnx'),
    ).toBe(false);
    expect(
      isAllowedModelRedirectUrl('https://evil.example.org/model.onnx'),
    ).toBe(false);
  });

  it('downloads fresh files, supports pause/resume via HTTP 206 Range, reconciles on restart, and cleans up on remove()', async () => {
    const modelBytes = makeFakeBytes(32 * 1024, 3);
    const voiceBytes = makeFakeBytes(8 * 1024, 9);
    const manifest = makeTestManifest(modelBytes, voiceBytes);
    const rangeHeadersSeen: string[] = [];

    const srv = await startHttpFixture((req, res) => {
      const urlPath = req.url ?? '';
      const payload = urlPath.includes('model.onnx') ? modelBytes : voiceBytes;
      const range = req.headers['range'];
      if (typeof range === 'string') {
        rangeHeadersSeen.push(range);
        const m = /^bytes=(\d+)-$/.exec(range);
        if (m) {
          const start = Number.parseInt(m[1]!, 10);
          if (start >= payload.byteLength) {
            res.writeHead(416, { 'Content-Range': `bytes */${payload.byteLength}` });
            res.end();
            return;
          }
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength}`,
            'Content-Length': String(payload.byteLength - start),
          });
          res.end(payload.subarray(start));
          return;
        }
      }
      res.writeHead(200, { 'Content-Length': String(payload.byteLength) });
      res.end(payload);
    });

    // Seed a partial .part file to verify HTTP 206 resume from exact offset
    const modelDir = join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.onnx.part'), modelBytes.subarray(0, 12_345));

    const store1 = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: (e) => events.push(e),
      retryDelaysMs: [0, 10],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1'],
      sourcesOverrideForTests: [srv.url],
      resolveFilesForTests: () => manifest,
      minFreeMarginBytes: 0,
    });

    // Startup reconciliation sees `.part` -> 'paused'
    expect(store1.status(KOKORO_MODEL_ID).state).toBe('paused');
    expect(store1.status(KOKORO_MODEL_ID).bytesDone).toBe(12_345);

    await store1.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await store1.waitForIdle();

    expect(rangeHeadersSeen).toContain('bytes=12345-');
    const readyStatus = store1.status(KOKORO_MODEL_ID);
    expect(readyStatus.state).toBe('ready');
    expect(readyStatus.installedVoices).toEqual(['zf_001']);
    expect(readFileSync(join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx', 'model.onnx'))).toEqual(
      Buffer.from(modelBytes),
    );
    expect(existsSync(join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx', 'model.onnx.part'))).toBe(false);

    // Restart reconciliation: new ModelStore sees installed.json + matching sizes -> 'ready'
    const store2 = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: () => undefined,
    });
    expect(store2.status(KOKORO_MODEL_ID).state).toBe('ready');
    expect(store2.status(KOKORO_MODEL_ID).installedVoices).toEqual(['zf_001']);
    expect(store2.totalBytes()).toBeGreaterThanOrEqual(modelBytes.byteLength + voiceBytes.byteLength);

    // Remove deletes directory & files
    await store2.remove(KOKORO_MODEL_ID);
    expect(store2.status(KOKORO_MODEL_ID).state).toBe('absent');
    expect(existsSync(join(tempDir, 'models', KOKORO_MODEL_ID))).toBe(false);
  });

  it('handles 200-ignored-Range, 416 unsatisfiable Range, primary 503 -> mirror fallback, and pause()', async () => {
    const modelBytes = makeFakeBytes(16 * 1024, 17);
    const voiceBytes = makeFakeBytes(4 * 1024, 19);
    const manifest = makeTestManifest(modelBytes, voiceBytes);

    let mirrorHits = 0;
    const primary = await startHttpFixture((_req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });
    const mirror = await startHttpFixture((req, res) => {
      mirrorHits += 1;
      const payload = (req.url ?? '').includes('model.onnx') ? modelBytes : voiceBytes;
      // Ignore Range header and return full 200 (also test 416 on first hit)
      if (mirrorHits === 1 && req.headers['range']) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Length': String(payload.byteLength) });
      res.end(payload);
    });

    const modelDir = join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.onnx.part'), modelBytes.subarray(0, 4096));

    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: (e) => events.push(e),
      retryDelaysMs: [0, 5],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1'],
      sourcesOverrideForTests: [primary.url, mirror.url],
      resolveFilesForTests: () => manifest,
      minFreeMarginBytes: 0,
    });

    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await store.waitForIdle();

    expect(mirrorHits).toBeGreaterThanOrEqual(2);
    expect(store.status(KOKORO_MODEL_ID).state).toBe('ready');
    expect(readFileSync(join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx', 'model.onnx'))).toEqual(
      Buffer.from(modelBytes),
    );
  });

  it('follows cross-host 302/308 redirects inside allowlist and rejects disallowed redirect hosts', async () => {
    const modelBytes = makeFakeBytes(8 * 1024, 41);
    const voiceBytes = makeFakeBytes(2 * 1024, 43);
    const manifest = makeTestManifest(modelBytes, voiceBytes);

    const cdn = await startHttpFixture((req, res) => {
      const payload = (req.url ?? '').includes('model.onnx') ? modelBytes : voiceBytes;
      res.writeHead(200, { 'Content-Length': String(payload.byteLength) });
      res.end(payload);
    });

    let redirectToEvil = true;
    const redirector = await startHttpFixture((req, res) => {
      const loc = redirectToEvil
        ? `http://evil.invalid:${cdn.port}${req.url}`
        : `http://localhost:${cdn.port}${req.url}`;
      res.writeHead(308, { Location: loc });
      res.end();
    });

    const storeFail = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: () => undefined,
      retryDelaysMs: [0],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1', 'localhost'],
      sourcesOverrideForTests: [redirector.url],
      resolveFilesForTests: () => manifest,
      minFreeMarginBytes: 0,
    });

    await storeFail.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await storeFail.waitForIdle();
    expect(storeFail.status(KOKORO_MODEL_ID).state).toBe('error');
    expect(storeFail.status(KOKORO_MODEL_ID).error?.code).toBe('network');

    // Now redirect to allow-listed `localhost`
    redirectToEvil = false;
    await storeFail.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await storeFail.waitForIdle();
    expect(storeFail.status(KOKORO_MODEL_ID).state).toBe('ready');
  });

  it('retries once on SHA-256 mismatch and surfaces model-integrity if corrupted twice', async () => {
    const modelBytes = makeFakeBytes(8 * 1024, 51);
    const voiceBytes = makeFakeBytes(2 * 1024, 53);
    const manifest = makeTestManifest(modelBytes, voiceBytes);
    const corrupted = new Uint8Array(modelBytes);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;

    let attempts = 0;
    const srv = await startHttpFixture((req, res) => {
      if ((req.url ?? '').includes('model.onnx')) {
        attempts += 1;
        res.writeHead(200, { 'Content-Length': String(corrupted.byteLength) });
        res.end(corrupted);
        return;
      }
      res.writeHead(200, { 'Content-Length': String(voiceBytes.byteLength) });
      res.end(voiceBytes);
    });

    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: () => undefined,
      retryDelaysMs: [0],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1'],
      sourcesOverrideForTests: [srv.url],
      resolveFilesForTests: () => manifest,
      minFreeMarginBytes: 0,
    });

    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await store.waitForIdle();

    expect(attempts).toBe(2); // initial + 1 clean integrity retry
    expect(store.status(KOKORO_MODEL_ID).state).toBe('error');
    expect(store.status(KOKORO_MODEL_ID).error?.code).toBe('model-integrity');
  });

  it('pauses active download preserving .part and reports storage-full when disk is tight', async () => {
    const modelBytes = makeFakeBytes(64 * 1024, 61);
    const voiceBytes = makeFakeBytes(4 * 1024, 63);
    const manifest = makeTestManifest(modelBytes, voiceBytes);

    let pauseResolve!: () => void;
    const firstChunkSent = new Promise<void>((r) => {
      pauseResolve = r;
    });

    const slowServer = await startHttpFixture((req, res) => {
      res.writeHead(200, { 'Content-Length': String(modelBytes.byteLength) });
      res.write(modelBytes.subarray(0, 4096));
      pauseResolve();
      // Keep socket open until aborted by pause()
      req.on('close', () => res.end());
    });

    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: (e) => events.push(e),
      retryDelaysMs: [0],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1'],
      sourcesOverrideForTests: [slowServer.url],
      resolveFilesForTests: () => manifest,
      minFreeMarginBytes: 0,
    });

    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await firstChunkSent;
    await new Promise((r) => setTimeout(r, 20));
    const paused = await store.pause(KOKORO_MODEL_ID);
    expect(paused.state).toBe('paused');
    expect(existsSync(join(tempDir, 'models', KOKORO_MODEL_ID, 'onnx', 'model.onnx.part'))).toBe(true);

    await store.remove(KOKORO_MODEL_ID);
    expect(existsSync(join(tempDir, 'models', KOKORO_MODEL_ID))).toBe(false);

    // Storage-full check
    const tightStore = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: () => undefined,
      getFreeBytesImpl: () => 1024,
      minFreeMarginBytes: 64 * 1024 * 1024,
    });
    const errStatus = await tightStore.download(KOKORO_MODEL_ID);
    expect(errStatus.state).toBe('error');
    expect(errStatus.error?.code).toBe('storage-full');
  });
});
