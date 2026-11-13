import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, MiniBookError, encodeMonoPcm16Wav, type AppSettings } from '@minibook/core';
import { openDatabase, type Database } from '../db/sqlite.js';
import { FileSecretStore } from '../settings/secrets.js';
import { assertAllowedOutboundSpeechUrl } from './allowlist.js';
import { SpeechAudioCache } from './audio-cache.js';
import { createNodeHttpTransport } from './http-transport.js';
import { SynthService } from './synth-service.js';

describe('SynthService, outbound speech allowlist, secret substitution & single-flight cache', () => {
  let tempDir: string;
  let db: Database;
  let secrets: FileSecretStore;
  let cache: SpeechAudioCache;
  let settings: AppSettings;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'minibook-synth-test-'));
    db = openDatabase(join(tempDir, 'test.sqlite'));
    secrets = new FileSecretStore(tempDir);
    cache = new SpeechAudioCache(db, tempDir, 1024 * 1024);
    settings = {
      ...DEFAULT_APP_SETTINGS,
      customSpeechServer: {
        baseUrl: 'http://127.0.0.1:8090/v1',
        model: 'kokoro',
        voice: 'af_heart',
      },
    };
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('strictly blocks open-proxy / SSRF URLs and allows only Edge + configured custom baseUrl', () => {
    // Allowed Edge WSS + HTTPS voices list
    expect(() =>
      assertAllowedOutboundSpeechUrl(
        'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=abc',
        { allowEdge: true, configuredCustomBaseUrl: null },
      ),
    ).not.toThrow();

    expect(() =>
      assertAllowedOutboundSpeechUrl(
        'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=abc',
        { allowEdge: true, configuredCustomBaseUrl: null },
      ),
    ).not.toThrow();

    // Allowed configured custom speech endpoint
    expect(() =>
      assertAllowedOutboundSpeechUrl('http://127.0.0.1:8090/v1/audio/speech', {
        allowEdge: false,
        configuredCustomBaseUrl: 'http://127.0.0.1:8090/v1',
      }),
    ).not.toThrow();

    // Blocked: cloud metadata SSRF
    expect(() =>
      assertAllowedOutboundSpeechUrl('http://169.254.169.254/latest/meta-data/', {
        allowEdge: true,
        configuredCustomBaseUrl: 'http://127.0.0.1:8090/v1',
      }),
    ).toThrow(MiniBookError);

    // Blocked: different port/origin than configured custom server
    expect(() =>
      assertAllowedOutboundSpeechUrl('http://127.0.0.1:9999/v1/audio/speech', {
        allowEdge: true,
        configuredCustomBaseUrl: 'http://127.0.0.1:8090/v1',
      }),
    ).toThrow(MiniBookError);

    // Blocked: arbitrary non-speech path on configured host (no open proxy!)
    expect(() =>
      assertAllowedOutboundSpeechUrl('http://127.0.0.1:8090/v1/admin/shutdown', {
        allowEdge: true,
        configuredCustomBaseUrl: 'http://127.0.0.1:8090/v1',
      }),
    ).toThrow(MiniBookError);
  });

  it('substitutes {{secret:name}} in NodeHttpTransport and blocks unallowed URLs', async () => {
    secrets.set('custom-speech-key', 'sk-live-secret-999');
    let seenAuthHeader: string | null = null;

    const transport = createNodeHttpTransport({
      secrets,
      getAllowedCustomBaseUrl: () => settings.customSpeechServer?.baseUrl ?? null,
      fetchImpl: async (_input, init) => {
        const hdrs = init?.headers as Record<string, string>;
        seenAuthHeader = hdrs['Authorization'] ?? null;
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      },
    });

    const ok = await transport({
      url: 'http://127.0.0.1:8090/v1/audio/speech',
      method: 'POST',
      headers: {
        Authorization: 'Bearer {{secret:custom-speech-key}}',
        'Content-Type': 'application/json',
      },
      body: '{"input":"Hello"}',
    });

    expect(ok.status).toBe(200);
    expect(seenAuthHeader).toBe('Bearer sk-live-secret-999');

    // SSRF attempt through transport is blocked before fetch is called
    await expect(
      transport({
        url: 'https://evil.example.org/v1/audio/speech',
        method: 'POST',
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('deduplicates concurrent synthesis requests per key and serves subsequent hits from disk cache', async () => {
    secrets.set('custom-speech-key', 'sk-test-123');
    let providerCalls = 0;
    let capturedAuthPlaceholder: string | undefined;

    const synth = new SynthService({
      getSettings: () => settings,
      secrets,
      cache,
      openAiProvider: {
        async synthesize(req) {
          providerCalls += 1;
          capturedAuthPlaceholder = req.apiKeyHeader;
          await new Promise((r) => setTimeout(r, 30));
          return {
            audio: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
            mime: 'audio/mpeg',
            durationMs: 1450,
          };
        },
        async listVoices() {
          return [];
        },
      },
    });

    const req = {
      engine: 'openai' as const,
      voiceId: 'af_heart',
      model: 'kokoro',
      text: 'It was the best of times.',
      lang: 'en',
    };

    const [r1, r2] = await Promise.all([synth.synthesize(req), synth.synthesize(req)]);
    expect(providerCalls).toBe(1);
    expect(capturedAuthPlaceholder).toBe('Bearer {{secret:custom-speech-key}}');
    expect(r1.ref).toBe(r2.ref);
    expect(r1.bytes).toBe(8);
    expect(r1.durationMs).toBe(1450);

    // Subsequent call hits disk/SQLite cache without invoking provider
    const r3 = await synth.synthesize(req);
    expect(providerCalls).toBe(1);
    expect(r3.cached).toBe(true);
    expect(synth.cacheSize()).toBe(8);

    // Rejects mismatched baseUrl override on synthesize
    await expect(
      synth.synthesize({
        ...req,
        text: 'Different sentence',
        baseUrl: 'http://evil.internal:8080/v1',
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    synth.clearCache();
    expect(synth.cacheSize()).toBe(0);
  });

  it('allows configured qwenServer origins (/v1/audio/speech, /synthesize, /health), injects qwen-api-key, and blocks caller baseUrl overrides', async () => {
    expect(() =>
      assertAllowedOutboundSpeechUrl('http://192.168.1.20:8000/v1/audio/speech', {
        allowEdge: false,
        configuredQwenBaseUrl: 'http://192.168.1.20:8000',
      }),
    ).not.toThrow();

    expect(() =>
      assertAllowedOutboundSpeechUrl('http://192.168.1.20:8000/synthesize', {
        allowEdge: false,
        configuredQwenBaseUrl: 'http://192.168.1.20:8000',
      }),
    ).not.toThrow();

    expect(() =>
      assertAllowedOutboundSpeechUrl('http://192.168.1.20:8000/health', {
        allowEdge: false,
        configuredQwenBaseUrl: 'http://192.168.1.20:8000/synthesize',
      }),
    ).not.toThrow();

    expect(() =>
      assertAllowedOutboundSpeechUrl('http://192.168.1.20:8000/admin', {
        allowEdge: false,
        configuredQwenBaseUrl: 'http://192.168.1.20:8000',
      }),
    ).toThrow(MiniBookError);

    secrets.set('qwen-api-key', 'sk-qwen-local');
    const wavBytes = encodeMonoPcm16Wav(new Float32Array(2400).fill(0.1), 24_000).wav;
    let seenAuth = '';
    let seenUrl = '';

    const transport = createNodeHttpTransport({
      secrets,
      getAllowedCustomBaseUrl: () => null,
      getAllowedQwenBaseUrl: () => settings.qwenServer?.baseUrl ?? null,
      fetchImpl: async (input, init) => {
        seenUrl = String(input);
        const hdrs = init?.headers as Record<string, string>;
        seenAuth = hdrs['Authorization'] ?? '';
        return new Response(new Uint8Array(wavBytes), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        });
      },
    });

    settings = {
      ...settings,
      qwenServer: {
        baseUrl: 'http://192.168.1.20:8000',
        protocol: 'mlx-audio',
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',
        voice: 'Vivian',
      },
    };

    const synth = new SynthService({
      getSettings: () => settings,
      secrets,
      cache,
      httpTransport: transport,
    });

    const voices = await synth.listRemoteVoices('qwen');
    expect(voices.some((v) => v.id === 'Vivian' && v.provider === 'qwen')).toBe(true);

    const res = await synth.synthesize({
      engine: 'qwen',
      voiceId: 'Vivian',
      text: '你好，世界。',
      lang: 'zh-CN',
    });
    expect(seenUrl).toBe('http://192.168.1.20:8000/v1/audio/speech');
    expect(seenAuth).toBe('Bearer sk-qwen-local');
    expect(res.mime).toBe('audio/wav');
    expect(res.cached).toBe(false);

    // Caller override to unconfigured origin is rejected
    await expect(
      synth.synthesize({
        engine: 'qwen',
        voiceId: 'Vivian',
        text: 'Other sentence',
        lang: 'zh-CN',
        baseUrl: 'http://10.0.0.5:8000',
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
