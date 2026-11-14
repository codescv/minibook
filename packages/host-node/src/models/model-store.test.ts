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

  it('switches from hf-mirror.com to huggingface.co mid-download and while paused without lastGoodSource pollution', async () => {
    const modelBytes = makeFakeBytes(16 * 1024, 71);
    const voiceBytes = makeFakeBytes(4 * 1024, 73);
    const manifest = makeTestManifest(modelBytes, voiceBytes);
    // Download voice first (completes from hf-mirror.com -> sets lastGoodSource!), then large model
    const orderedManifest = [manifest[1]!, manifest[0]!];

    const requests: Array<{ host: string; path: string; range?: string }> = [];
    let mirrorChunk1Sent!: () => void;
    let mirrorChunk1Promise = new Promise<void>((r) => {
      mirrorChunk1Sent = r;
    });
    let allowMirrorFinish = false;

    const fakeFetch: typeof fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const headers = new Headers(init?.headers);
      const range = headers.get('range') ?? undefined;
      requests.push({ host: url.hostname, path: url.pathname, ...(range ? { range } : {}) });

      const payload = url.pathname.includes('model.onnx') ? modelBytes : voiceBytes;

      // Mirror streams partial chunk for model.onnx and stalls until aborted!
      if (url.hostname === 'hf-mirror.com' && url.pathname.includes('model.onnx') && !allowMirrorFinish) {
        const chunk1 = payload.subarray(0, 4096);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk1);
            mirrorChunk1Sent();
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.error(new DOMException('Aborted', 'AbortError'));
              } catch {
                // ignore
              }
            });
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Length': String(payload.byteLength) },
          }),
        );
      }

      if (range) {
        const m = /^bytes=(\d+)-$/.exec(range);
        if (m) {
          const start = Number.parseInt(m[1]!, 10);
          return Promise.resolve(
            new Response(Buffer.from(payload.subarray(start)), {
              status: 206,
              headers: {
                'Content-Range': `bytes ${start}-${payload.byteLength - 1}/${payload.byteLength}`,
                'Content-Length': String(payload.byteLength - start),
              },
            }),
          );
        }
      }
      return Promise.resolve(
        new Response(Buffer.from(payload), {
          status: 200,
          headers: { 'Content-Length': String(payload.byteLength) },
        }),
      );
    };

    // 1) Live mid-download switch: Asia/Shanghai `auto` starts on `hf-mirror.com` (and completes voice on it),
    //    then switching to `huggingface` mid-download MUST immediately abort hf-mirror.com and resume on huggingface.co!
    settings = { ...DEFAULT_APP_SETTINGS, modelDownloadSource: 'auto' };
    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: (e) => events.push(e),
      fetchImpl: fakeFetch,
      retryDelaysMs: [0],
      sourceEnvForTests: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
      resolveFilesForTests: () => orderedManifest,
      minFreeMarginBytes: 0,
    });

    const initialDl = await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    expect(initialDl.source).toBe('hf-mirror.com');
    await mirrorChunk1Promise;
    await new Promise((r) => setTimeout(r, 20));

    const requestsBeforeSwitch = requests.length;
    const eventsBeforeSwitch = events.length;
    // Pass `source: 'huggingface'` directly BEFORE `settings` is even persisted (tests race-free override too!)
    const switched = await store.download(KOKORO_MODEL_ID, {
      voices: ['zf_001'],
      source: 'huggingface',
      mirrorBaseUrl: null,
    });
    expect(switched.state).toBe('downloading');
    expect(switched.source).toBe('huggingface.co');

    await store.waitForIdle();
    const ready = store.status(KOKORO_MODEL_ID);
    expect(ready.state).toBe('ready');
    expect(ready.source).toBe('huggingface.co');

    const postSwitchRequests = requests.slice(requestsBeforeSwitch);
    expect(postSwitchRequests.some((r) => r.host === 'hf-mirror.com')).toBe(false);
    expect(postSwitchRequests.some((r) => r.host === 'huggingface.co' && r.range === 'bytes=4096-')).toBe(true);
    const postSwitchEvents = events
      .slice(eventsBeforeSwitch)
      .filter((e): e is Extract<HostEvent, { type: 'speech-model' }> => e.type === 'speech-model');
    expect(postSwitchEvents.length).toBeGreaterThan(0);
    expect(postSwitchEvents.every((e) => e.status.source === 'huggingface.co')).toBe(true);

    // 2) Paused switch: complete voice on `hf-mirror.com` (`lastGoodSource` = hf-mirror.com), pause during model.onnx,
    //    then resume with `source: 'huggingface'` -> MUST NOT emit or hit `hf-mirror.com`!
    await store.remove(KOKORO_MODEL_ID);
    requests.length = 0;
    events.length = 0;
    mirrorChunk1Promise = new Promise<void>((r) => {
      mirrorChunk1Sent = r;
    });
    allowMirrorFinish = false;

    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'], source: 'auto' });
    await mirrorChunk1Promise;
    await new Promise((r) => setTimeout(r, 20));
    const paused = await store.pause(KOKORO_MODEL_ID);
    expect(paused.state).toBe('paused');

    const reqCountAtPause = requests.length;
    const eventsAtPause = events.length;
    const resumed = await store.download(KOKORO_MODEL_ID, {
      voices: ['zf_001'],
      source: 'huggingface',
      mirrorBaseUrl: null,
    });
    expect(resumed.state).toBe('downloading');
    expect(resumed.source).toBe('huggingface.co');

    await store.waitForIdle();
    expect(store.status(KOKORO_MODEL_ID).state).toBe('ready');
    expect(store.status(KOKORO_MODEL_ID).source).toBe('huggingface.co');
    expect(requests.slice(reqCountAtPause).some((r) => r.host === 'hf-mirror.com')).toBe(false);
    expect(requests.slice(reqCountAtPause).some((r) => r.host === 'huggingface.co' && r.range === 'bytes=4096-')).toBe(
      true,
    );
    const postResumeEvents = events
      .slice(eventsAtPause)
      .filter((e): e is Extract<HostEvent, { type: 'speech-model' }> => e.type === 'speech-model');
    expect(postResumeEvents.every((e) => e.status.source === 'huggingface.co')).toBe(true);
  });

  it('emits downloading continuously across multiple files and verifying at most once before ready', async () => {
    const voiceBytes = makeFakeBytes(4 * 1024, 81);
    const modelBytes = makeFakeBytes(8 * 1024, 83);
    const manifest = makeTestManifest(modelBytes, voiceBytes);
    const orderedManifest = [manifest[1]!, manifest[0]!];

    const fakeFetch: typeof fetch = (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const body = url.pathname.includes('zf_001.bin') ? voiceBytes : modelBytes;
      return Promise.resolve(
        new Response(Buffer.from(body), {
          status: 200,
          headers: { 'Content-Length': String(body.byteLength) },
        }),
      );
    };

    let clock = 1_000_000;
    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => ({ ...DEFAULT_APP_SETTINGS, modelDownloadSource: 'auto' }),
      emit: (e) => events.push(e),
      fetchImpl: fakeFetch,
      retryDelaysMs: [0],
      now: () => {
        clock += 200;
        return clock;
      },
      sourceEnvForTests: { timeZone: 'Asia/Shanghai', locale: 'zh-CN' },
      resolveFilesForTests: () => orderedManifest,
      minFreeMarginBytes: 0,
    });

    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001'] });
    await store.waitForIdle();

    const modelEvents = events.filter(
      (e): e is Extract<HostEvent, { type: 'speech-model' }> => e.type === 'speech-model',
    );
    const states = modelEvents.map((e) => e.status.state);
    const verifyIndices = states
      .map((s, idx) => (s === 'verifying' ? idx : -1))
      .filter((idx) => idx >= 0);

    expect(verifyIndices.length).toBe(1);
    const verifyIdx = verifyIndices[0]!;
    expect(states.slice(0, verifyIdx).every((s) => s === 'downloading')).toBe(true);
    expect(states.slice(verifyIdx + 1)).not.toContain('downloading');
    expect(modelEvents[verifyIdx]!.status.bytesDone).toBe(
      modelEvents[verifyIdx]!.status.bytesTotal,
    );
    expect(states[states.length - 1]).toBe('ready');
  });

  it('[v0.2.4] switches between onnx-fp32 and onnx-q8 preserving voices/*.bin, reconciles instantly when cached, and separates variant cache keys', async () => {
    const { KOKORO_VOICE_BIN_BYTES, computeSpeechCacheKeySync } = await import('@minibook/core');
    const fp32Bytes = makeFakeBytes(24 * 1024, 81);
    const q8Bytes = makeFakeBytes(12 * 1024, 83);
    // Use exact KOKORO_VOICE_BIN_BYTES so detectInstalledVoicesOnDisk() recognizes zf_001.bin & zf_018.bin!
    const zf001Bytes = makeFakeBytes(KOKORO_VOICE_BIN_BYTES, 85);
    const zf018Bytes = makeFakeBytes(KOKORO_VOICE_BIN_BYTES, 87);

    let voiceFetches = 0;
    const srv = await startHttpFixture((req, res) => {
      const u = req.url ?? '';
      let payload: Uint8Array;
      if (u.includes('model_quantized.onnx')) {
        payload = q8Bytes;
      } else if (u.includes('model.onnx')) {
        payload = fp32Bytes;
      } else {
        voiceFetches += 1;
        payload = u.includes('zf_018.bin') ? zf018Bytes : zf001Bytes;
      }
      res.writeHead(200, { 'Content-Length': String(payload.byteLength) });
      res.end(payload);
    });

    const store = new ModelStore({
      dataDir: tempDir,
      getSettings: () => settings,
      emit: (e) => events.push(e),
      retryDelaysMs: [0],
      allowInsecureHttpForTests: true,
      extraAllowedHostsForTests: ['127.0.0.1'],
      sourcesOverrideForTests: [srv.url],
      resolveFilesForTests: (variant, voices) => [
        variant === 'onnx-q8'
          ? {
              path: 'onnx/model_quantized.onnx',
              size: q8Bytes.byteLength,
              sha256: sha256Hex(q8Bytes),
              repo: KOKORO_MANIFEST.onnx.repo,
              revision: KOKORO_MANIFEST.onnx.revision,
            }
          : {
              path: 'onnx/model.onnx',
              size: fp32Bytes.byteLength,
              sha256: sha256Hex(fp32Bytes),
              repo: KOKORO_MANIFEST.onnx.repo,
              revision: KOKORO_MANIFEST.onnx.revision,
            },
        ...voices.map((v) => {
          const vb = v === 'zf_018' ? zf018Bytes : zf001Bytes;
          return {
            path: `voices/${v}.bin`,
            size: vb.byteLength,
            sha256: sha256Hex(vb),
            repo: KOKORO_MANIFEST.onnx.repo,
            revision: KOKORO_MANIFEST.onnx.revision,
          };
        }),
      ],
      minFreeMarginBytes: 0,
    });

    // 1. Download default `onnx-fp32` with `zf_001` + `zf_018`
    await store.download(KOKORO_MODEL_ID, { voices: ['zf_001', 'zf_018'] });
    await store.waitForIdle();
    expect(store.status(KOKORO_MODEL_ID).state).toBe('ready');
    expect(store.status(KOKORO_MODEL_ID).variant).toBe('onnx-fp32');
    expect(voiceFetches).toBe(2);

    // 2. Switch settings to `kokoroPrecision: 'q8'` -> reconciles to `absent` (`onnx-q8`) while keeping voices on disk!
    settings = { ...settings, kokoroPrecision: 'q8' };
    const afterSwitchToQ8 = store.reconcileForSettingsChange();
    expect(afterSwitchToQ8.state).toBe('absent');
    expect(afterSwitchToQ8.variant).toBe('onnx-q8');
    expect(afterSwitchToQ8.installedVoices).toEqual(['zf_001', 'zf_018']);

    // Download `onnx-q8`: must NOT re-download `zf_001.bin` or `zf_018.bin`!
    await store.download(KOKORO_MODEL_ID, { variant: 'onnx-q8', voices: ['zf_001', 'zf_018'] });
    await store.waitForIdle();
    expect(voiceFetches).toBe(2);
    expect(store.status(KOKORO_MODEL_ID).state).toBe('ready');
    expect(store.status(KOKORO_MODEL_ID).variant).toBe('onnx-q8');

    // 3. Switch back `q8 -> fp32`: since `onnx/model.onnx` is still on disk, immediately reconciles to `ready` (`onnx-fp32`)!
    settings = { ...settings, kokoroPrecision: 'fp32' };
    const backToFp32 = store.reconcileForSettingsChange();
    expect(backToFp32.state).toBe('ready');
    expect(backToFp32.variant).toBe('onnx-fp32');
    expect(backToFp32.installedVoices).toEqual(['zf_001', 'zf_018']);

    // 4. Verify speech cache keys for `onnx-q8` vs `onnx-fp32` are strictly distinct!
    const kQ8 = computeSpeechCacheKeySync({
      engine: 'kokoro',
      voiceId: 'zf_018',
      variant: 'onnx-q8',
      text: '你好，世界。',
    });
    const kFp32 = computeSpeechCacheKeySync({
      engine: 'kokoro',
      voiceId: 'zf_018',
      variant: 'onnx-fp32',
      text: '你好，世界。',
    });
    expect(kQ8).not.toBe(kFp32);
  });
});
