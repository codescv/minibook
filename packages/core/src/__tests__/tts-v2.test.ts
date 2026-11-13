import { gunzipSync } from 'fflate';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALLOWED_MODEL_HOSTS,
  KOKORO_DEFAULT_VOICES,
  KOKORO_G2P_EN_ASSETS,
  KOKORO_G2P_VERSION,
  KOKORO_G2P_ZH_ASSETS,
  KOKORO_MANIFEST,
  KOKORO_MAX_CHUNK_TOKENS,
  KOKORO_MAX_VOCAB_ID,
  KOKORO_SELF_TEST_IDS,
  KOKORO_SELF_TEST_PHONEMES,
  KOKORO_TARGET_CHUNK_TOKENS,
  KOKORO_VOCAB,
  KOKORO_VOICE_BIN_BYTES,
  MiniBookError,
  QwenSpeechProvider,
  SynthScheduler,
  buildModelResolveUrl,
  computeKokoroModelCacheTag,
  computeQwenModelCacheTag,
  computeSpeechCacheKeySync,
  concatWav,
  createKokoroG2P,
  encodeKokoroPhonemes,
  encodeMonoPcm16Wav,
  extractKokoroVoiceStyleRow,
  formatKokoroVoiceName,
  isAllowedModelRedirectUrl,
  isSafeManifestRelativePath,
  kokoroSpeed,
  kokoroStyleRowIndex,
  normalizeForKokoro,
  padKokoroTokenIds,
  parseWav,
  resolveAllowedModelHosts,
  resolveManifestFilesForVariant,
  resolveModelSources,
  splitForQwen,
  splitKokoroCoreMLVoiceRow,
  validateKokoroWaveform,
  wordMarksFromKokoroDurations,
  type HttpTransport,
  type QwenServerConfig,
  type TransportHttpRequest,
  type Utterance,
} from '../index.js';

const THIS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ASSETS_DIR = resolve(THIS_DIR, '..', '..', 'assets', 'kokoro-g2p', 'v1');
const REF_JSONL_PATH = resolve(THIS_DIR, 'fixtures', 'kokoro-g2p-ref.jsonl');
const BENCHMARK_JSON_PATH = resolve(THIS_DIR, 'fixtures', 'kokoro-benchmark-ane-zh.json');

const REVERSE_VOCAB = new Map<number, string>(
  Object.entries(KOKORO_VOCAB).map(([ch, id]) => [id, ch]),
);
const FORBIDDEN_START_IDS = new Set<number>(
  ['1', '2', '3', '4', '5', 'R'].map((ch) => KOKORO_VOCAB[ch]!),
);

function createFsG2pLoader(preDecompress = false) {
  return async (name: string): Promise<Uint8Array> => {
    const fileName = name.endsWith('.gz') ? name : `${name}.gz`;
    const bytes = new Uint8Array(readFileSync(resolve(ASSETS_DIR, fileName)));
    return preDecompress ? gunzipSync(bytes) : bytes;
  };
}

function assertValidUtf16Boundary(text: string, idx: number): void {
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(idx).toBeLessThanOrEqual(text.length);
  if (idx > 0 && idx < text.length) {
    const prevCode = text.charCodeAt(idx - 1);
    const curCode = text.charCodeAt(idx);
    const splitsSurrogatePair =
      prevCode >= 0xd800 && prevCode <= 0xdbff && curCode >= 0xdc00 && curCode <= 0xdfff;
    expect(splitsSurrogatePair, `UTF-16 index ${idx} splits surrogate pair in "${text}"`).toBe(false);
  }
}

describe('Kokoro-82M v1.1-zh Pure-TS G2P (TTS_V2_SPEC.md §4)', () => {
  const g2p = createKokoroG2P({ loadAsset: createFsG2pLoader(false) });

  it('keeps bundled zh gzip assets strictly <= 4 MB budget and accepts both .gz and raw bytes', async () => {
    let zhGzipBytes = 0;
    for (const name of KOKORO_G2P_ZH_ASSETS) {
      const st = statSync(resolve(ASSETS_DIR, name));
      expect(st.size).toBeGreaterThan(100);
      zhGzipBytes += st.size;
    }
    expect(zhGzipBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

    for (const name of KOKORO_G2P_EN_ASSETS) {
      const st = statSync(resolve(ASSETS_DIR, name));
      expect(st.size).toBeGreaterThan(100_000);
    }

    const rawG2p = createKokoroG2P({ loadAsset: createFsG2pLoader(true) });
    const a = await g2p.phonemize('你好，世界。', 'zh-CN');
    const b = await rawG2p.phonemize('你好，世界。', 'zh-CN');
    expect(b).toEqual(a);
  });

  it(
    'reproduces 498/498 (100%) of the misaki ZHG2P(version="1.1") golden corpus & satisfies all chunk/span invariants',
    async () => {
      const lines = readFileSync(REF_JSONL_PATH, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { text: string; phonemes: string; kind: string });
      expect(lines.length).toBe(498);

      await g2p.preload({ includeEnglish: true });

      let exactMatches = 0;
      const mismatches: Array<{ idx: number; text: string; expected: string; actual: string }> = [];

      for (let idx = 0; idx < lines.length; idx++) {
        const row = lines[idx]!;
        // 1. Exact misaki parity check (raw mode: normalize=false, enFallback=false)
        const rawOut = g2p.phonemizeSync!(row.text, 'zh-CN', {
          normalize: false,
          enFallback: false,
        });
        if (rawOut.phonemes === row.phonemes) {
          exactMatches++;
        } else {
          mismatches.push({
            idx,
            text: row.text,
            expected: row.phonemes,
            actual: rawOut.phonemes,
          });
        }

        // 2. Production mode invariants (normalize=true, enFallback=true)
        const needsProdPass =
          row.phonemes.includes('❓') || normalizeForKokoro(row.text) !== row.text;
        const prodOut = needsProdPass ? g2p.phonemizeSync!(row.text, 'zh-CN') : rawOut;
        const expectedFlat = encodeKokoroPhonemes(prodOut.phonemes);
        expect(prodOut.phonemeIds.flat()).toEqual(expectedFlat);
        expect(prodOut.phonemeSpeeds.length).toBe(prodOut.phonemeIds.length);
        expect(prodOut.phonemeSpans.length).toBe(prodOut.phonemeIds.length);

        for (let c = 0; c < prodOut.phonemeIds.length; c++) {
          const chunk = prodOut.phonemeIds[c]!;
          const spans = prodOut.phonemeSpans[c]!;
          expect(chunk.length).toBeGreaterThan(0);
          expect(chunk.length).toBeLessThanOrEqual(KOKORO_MAX_CHUNK_TOKENS);
          expect(
            FORBIDDEN_START_IDS.has(chunk[0]!),
            `Chunk ${c} started with tone/R in "${row.text}"`,
          ).toBe(false);

          for (const tokenId of chunk) {
            expect(Number.isInteger(tokenId)).toBe(true);
            expect(tokenId).toBeGreaterThanOrEqual(1);
            expect(tokenId).toBeLessThanOrEqual(KOKORO_MAX_VOCAB_ID);
            expect(REVERSE_VOCAB.has(tokenId)).toBe(true);
          }

          let prevT1 = 0;
          let prevC0 = 0;
          for (const sp of spans) {
            expect(sp.t0).toBeGreaterThanOrEqual(prevT1);
            expect(sp.t1).toBeGreaterThan(sp.t0);
            expect(sp.t1).toBeLessThanOrEqual(chunk.length);
            assertValidUtf16Boundary(row.text, sp.c0);
            assertValidUtf16Boundary(row.text, sp.c1);
            expect(sp.c1).toBeGreaterThan(sp.c0);
            expect(sp.c0).toBeGreaterThanOrEqual(prevC0);
            prevT1 = sp.t1;
            prevC0 = sp.c0;
          }
        }
      }

      expect(mismatches).toEqual([]);
      expect(exactMatches).toBe(498);
    },
    30_000,
  );

  it('matches all 6 official FluidInference/kokoro-82m-coreml ANE-zh benchmark strings 100%', async () => {
    const bench = JSON.parse(readFileSync(BENCHMARK_JSON_PATH, 'utf8')) as {
      cases: Array<{ id: number; text: string; phonemes: string; n_phonemes: number }>;
    };
    expect(bench.cases.length).toBe(6);

    for (const item of bench.cases) {
      const out = await g2p.phonemize(item.text, 'zh-CN');
      if (item.n_phonemes < 510) {
        expect(out.phonemes).toBe(item.phonemes);
        expect(Array.from(out.phonemes).length).toBe(item.n_phonemes);
      } else {
        // Case 5 in FluidInference benchmark_data.json is truncated at 510 chars; verify exact 510-char prefix
        // AND verify our chunker splits the full sentence cleanly into <= 400-token chunks!
        expect(Array.from(out.phonemes).slice(0, 510).join('')).toBe(item.phonemes);
        expect(out.phonemeIds.length).toBeGreaterThanOrEqual(2);
        for (const chunk of out.phonemeIds) {
          expect(chunk.length).toBeLessThanOrEqual(KOKORO_MAX_CHUNK_TOKENS);
          expect(FORBIDDEN_START_IDS.has(chunk[0]!)).toBe(false);
        }
      }
    }

    // Verify self-test constant matches Case 0 ("你好。" -> "ㄋㄧ2ㄏㄠ3.")
    expect(encodeKokoroPhonemes(KOKORO_SELF_TEST_PHONEMES)).toEqual([...KOKORO_SELF_TEST_IDS]);
    expect(padKokoroTokenIds(KOKORO_SELF_TEST_IDS)).toEqual([0, 73, 127, 172, 88, 108, 169, 4, 0]);
  });

  it('normalizes dates, times, thousands, ranges, phone numbers, currencies, full-width chars, and 〇 (§4.4)', async () => {
    expect(normalizeForKokoro('２０２４')).toBe('2024');
    expect(normalizeForKokoro('二〇二四年')).toBe('二零二四年');
    expect(normalizeForKokoro('2024-01-15')).toBe('2024年1月15日');
    expect(normalizeForKokoro('2024/1/15')).toBe('2024年1月15日');
    expect(normalizeForKokoro('12:30')).toBe('12点30分');
    expect(normalizeForKokoro('12:30:45')).toBe('12点30分45秒');
    expect(normalizeForKokoro('1,234,567.89')).toBe('1234567.89');
    expect(normalizeForKokoro('45%～60%')).toBe('45%到60%');
    expect(normalizeForKokoro('3~5')).toBe('3到5');
    expect(normalizeForKokoro('13800138000')).toBe('一三八零零一三八零零零');
    expect(normalizeForKokoro('$19.99')).toBe('19.99美元');
    expect(normalizeForKokoro('¥5')).toBe('5元');
    expect(normalizeForKokoro('￥5')).toBe('5元');
    expect(normalizeForKokoro("‘你好’『世界』...--[测试]")).toBe('“你好”“世界”…——(测试)');

    // Verify end-to-end phonemization + UTF-16 span bounds with numbers, currencies & astral emoji/BMP
    const normSentence = '2024-01-15 12:30，他花了$19.99买书，电话13800138000！';
    const normRes = await g2p.phonemize(normSentence, 'zh-CN');
    expect(normRes.phonemes.includes('❓')).toBe(false);

    const complex = '😀 2024-01-15 12:30，他花了$19.99买书，电话13800138000！𠀀';
    const res = await g2p.phonemize(complex, 'zh-CN');
    expect(res.phonemeIds.flat().length).toBeGreaterThan(30);
    for (const id of res.phonemeIds.flat()) {
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(KOKORO_MAX_VOCAB_ID);
    }
    for (let c = 0; c < res.phonemeIds.length; c++) {
      for (const sp of res.phonemeSpans[c]!) {
        assertValidUtf16Boundary(complex, sp.c0);
        assertValidUtf16Boundary(complex, sp.c1);
        expect(sp.c1).toBeGreaterThan(sp.c0);
      }
    }
  });

  it('handles pure English utterances (lang="en-US"), stemming, numbers, and OOV LTS fallback with valid vocab IDs', async () => {
    const enText =
      'In 1775, Mr. Lorry walked 3rd avenue with NASA engineers testing Xiaomi and Huawei prototypes.';
    const out = await g2p.phonemize(enText, 'en-US', { voiceId: 'af_maple' });
    expect(out.phonemes.includes('❓')).toBe(false);
    expect(out.phonemeSpeeds).toEqual([1.0]);
    expect(out.phonemeIds.length).toBe(1);
    const ids = out.phonemeIds[0]!;
    expect(ids.length).toBeGreaterThan(40);
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(KOKORO_MAX_VOCAB_ID);
    }
    const spans = out.phonemeSpans[0]!;
    expect(spans.length).toBeGreaterThan(10);
    const coveredWords = spans.map((sp) => enText.slice(sp.c0, sp.c1));
    expect(coveredWords).toContain('1775');
    expect(coveredWords).toContain('Mr.');
    expect(coveredWords).toContain('NASA');
    expect(coveredWords).toContain('Huawei');
  });

  it('computes kokoroSpeed curve and splits multi-paragraph inputs into <= KOKORO_MAX_CHUNK_TOKENS chunks', async () => {
    expect(kokoroSpeed(83, 'zf_001')).toBeCloseTo(1.1, 4);
    expect(kokoroSpeed(133, 'zf_001')).toBeCloseTo(0.99, 4);
    expect(kokoroSpeed(183, 'zf_001')).toBeCloseTo(0.88, 4);
    expect(kokoroSpeed(300, 'zm_010')).toBeCloseTo(0.88, 4);
    expect(kokoroSpeed(200, 'af_maple')).toBe(1.0);
    expect(kokoroSpeed(200, 'bf_vale')).toBe(1.0);

    const longSentence = '今天的天气真不错，阳光明媚，微风拂面。'.repeat(12);
    const out = await g2p.phonemize(longSentence, 'zh-CN');
    expect(out.phonemeIds.length).toBeGreaterThan(3);
    expect(out.phonemeIds.flat()).toEqual(encodeKokoroPhonemes(out.phonemes));
    for (const chunk of out.phonemeIds) {
      expect(chunk.length).toBeLessThanOrEqual(KOKORO_TARGET_CHUNK_TOKENS + 50);
      expect(chunk.length).toBeLessThanOrEqual(KOKORO_MAX_CHUNK_TOKENS);
      expect(FORBIDDEN_START_IDS.has(chunk[0]!)).toBe(false);
    }
  });
});

describe('Kokoro Manifest, Mirror Resolution, Voice Pack Slicing & WAV Timing (§3, §5)', () => {
  it('validates KOKORO_MANIFEST SHA-256 digests, 103 voices, and 34 Core ML stage files', () => {
    expect(Object.keys(KOKORO_VOCAB).length).toBe(172);
    expect(KOKORO_MANIFEST.modelId).toBe('kokoro-v1.1-zh');
    expect(KOKORO_MANIFEST.onnx.voices.length).toBe(103);
    expect(KOKORO_MANIFEST.coreml.stages).toEqual([
      'KokoroAlbert',
      'KokoroPostAlbert',
      'KokoroAlignment',
      'KokoroProsody_v2',
      'KokoroNoise_v2',
      'KokoroVocoder_v2',
      'KokoroTail_v2',
    ]);
    expect(KOKORO_MANIFEST.coreml.files.length).toBe(34);

    const shaRe = /^[0-9a-f]{64}$/;
    expect(KOKORO_MANIFEST.onnx.models.fp32.size).toBe(339_369_442);
    expect(KOKORO_MANIFEST.onnx.models.fp32.sha256).toMatch(shaRe);
    expect(KOKORO_MANIFEST.onnx.models.q8.size).toBe(127_356_597);
    expect(KOKORO_MANIFEST.onnx.models.q8.sha256).toMatch(shaRe);

    for (const v of KOKORO_MANIFEST.onnx.voices) {
      expect(v.size).toBe(KOKORO_VOICE_BIN_BYTES);
      expect(v.sha256).toMatch(shaRe);
      expect(isSafeManifestRelativePath(v.path)).toBe(true);
    }
    for (const f of KOKORO_MANIFEST.coreml.files) {
      expect(f.size).toBeGreaterThan(0);
      expect(f.sha256).toMatch(shaRe);
      expect(isSafeManifestRelativePath(f.path)).toBe(true);
    }

    expect(isSafeManifestRelativePath('../etc/passwd')).toBe(false);
    expect(isSafeManifestRelativePath('/abs/path.bin')).toBe(false);

    const androidFiles = resolveManifestFilesForVariant('onnx-q8');
    expect(androidFiles.length).toBe(1 + KOKORO_DEFAULT_VOICES.length);
    const iosFiles = resolveManifestFilesForVariant('coreml');
    expect(iosFiles.length).toBe(34 + KOKORO_DEFAULT_VOICES.length);
    expect(iosFiles[0]!.repo).toBe('FluidInference/kokoro-82m-coreml');
    expect(iosFiles[iosFiles.length - 1]!.repo).toBe('onnx-community/Kokoro-82M-v1.1-zh-ONNX');

    expect(formatKokoroVoiceName('zf_001', 'zh-CN')).toBe('Kokoro 女声 001');
    expect(formatKokoroVoiceName('zm_010', 'en-US')).toBe('Kokoro Male 010');
    expect(formatKokoroVoiceName('af_maple', 'zh-CN')).toBe('Kokoro Maple (US)');
    expect(formatKokoroVoiceName('bf_vale', 'en-US')).toBe('Kokoro Vale (UK)');
  });

  it('resolves huggingface.co, hf-mirror.com, and custom mirrors + enforces redirect host allow-list', () => {
    expect(resolveModelSources({ modelDownloadSource: 'auto' }, { timeZone: 'America/Los_Angeles', locale: 'en-US' })).toEqual([
      'https://huggingface.co',
      'https://hf-mirror.com',
    ]);
    expect(resolveModelSources({ modelDownloadSource: 'auto' }, { timeZone: 'Asia/Shanghai', locale: 'en-US' })).toEqual([
      'https://hf-mirror.com',
      'https://huggingface.co',
    ]);
    expect(resolveModelSources({ modelDownloadSource: 'auto' }, { timeZone: 'UTC', locale: 'zh-CN' })).toEqual([
      'https://hf-mirror.com',
      'https://huggingface.co',
    ]);
    expect(resolveModelSources({ modelDownloadSource: 'huggingface' })).toEqual(['https://huggingface.co']);
    expect(resolveModelSources({ modelDownloadSource: 'hf-mirror' })).toEqual(['https://hf-mirror.com']);
    expect(
      resolveModelSources({
        modelDownloadSource: 'custom',
        modelMirrorBaseUrl: 'https://mirror.corp.example.com/hf/',
      }),
    ).toEqual([
      'https://mirror.corp.example.com/hf',
      'https://hf-mirror.com',
      'https://huggingface.co',
    ]);

    expect(
      buildModelResolveUrl(
        'https://hf-mirror.com/',
        'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
        '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
        '/onnx/model_quantized.onnx',
      ),
    ).toBe(
      'https://hf-mirror.com/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3/onnx/model_quantized.onnx',
    );

    const allow = resolveAllowedModelHosts('https://mirror.corp.example.com/hf');
    expect(isAllowedModelRedirectUrl('https://huggingface.co/foo/bar', DEFAULT_ALLOWED_MODEL_HOSTS)).toBe(true);
    expect(isAllowedModelRedirectUrl('https://cas-bridge.xethub.hf.co/xet-bridge-us/123', DEFAULT_ALLOWED_MODEL_HOSTS)).toBe(true);
    expect(isAllowedModelRedirectUrl('https://cdn-lfs.hf-mirror.com/obj', DEFAULT_ALLOWED_MODEL_HOSTS)).toBe(true);
    expect(isAllowedModelRedirectUrl('https://mirror.corp.example.com/obj', allow)).toBe(true);

    // Reject HTTP downgrade & suffix-spoofed domains
    expect(isAllowedModelRedirectUrl('http://huggingface.co/foo', allow)).toBe(false);
    expect(isAllowedModelRedirectUrl('https://evil-huggingface.co/foo', allow)).toBe(false);
    expect(isAllowedModelRedirectUrl('https://attacker.example.com/foo', allow)).toBe(false);
  });

  it('slices (510, 1, 256) voice .bin packs, validates waveforms, and computes 25ms frame WordMarks', () => {
    expect(kokoroStyleRowIndex(0)).toBe(0);
    expect(kokoroStyleRowIndex(1)).toBe(0);
    expect(kokoroStyleRowIndex(55)).toBe(54);
    expect(kokoroStyleRowIndex(600)).toBe(509);

    const voiceBin = new Uint8Array(KOKORO_VOICE_BIN_BYTES);
    const dv = new DataView(voiceBin.buffer);
    // Write recognizable values in row 6 (for tokenCount = 7): timbre[0] = 0.25, style[0] = -0.75
    const row6Off = 6 * 256 * 4;
    dv.setFloat32(row6Off + 0, 0.25, true);
    dv.setFloat32(row6Off + 128 * 4, -0.75, true);

    const row = extractKokoroVoiceStyleRow(voiceBin, 7);
    expect(row.length).toBe(256);
    expect(row[0]).toBeCloseTo(0.25, 6);
    expect(row[128]).toBeCloseTo(-0.75, 6);

    const split = splitKokoroCoreMLVoiceRow(row);
    expect(split.timbre.length).toBe(128);
    expect(split.style.length).toBe(128);
    expect(split.timbre[0]).toBeCloseTo(0.25, 6);
    expect(split.style[0]).toBeCloseTo(-0.75, 6);

    // Waveform NaN / silence self-test guard
    expect(validateKokoroWaveform(new Float32Array([0, 0.2, -0.1, Number.NaN])).valid).toBe(false);
    expect(validateKokoroWaveform(new Float32Array(24_000).fill(0.0001)).valid).toBe(false);
    const cleanWave = new Float32Array(24_000);
    for (let i = 0; i < cleanWave.length; i++) cleanWave[i] = Math.sin(i * 0.1) * 0.25;
    expect(
      validateKokoroWaveform(cleanWave, { minPeak: 0.01, minDurationMs: 500, maxDurationMs: 4000 }).valid,
    ).toBe(true);

    // Frame durations -> WordMark[] (`paddedDurations` has leading & trailing pad frames)
    // Suppose text = "你好世界", chunk spans: "你好" = [0, 6) -> [0, 2), "/" = token 6, "世界" = [7, 12) -> [2, 4)
    const paddedDurations = [2, 3, 3, 2, 4, 4, 2, 1, 5, 5, 3, 3, 2, 2]; // 12 unpadded + 2 pads = 14
    const marks = wordMarksFromKokoroDurations(
      [
        { t0: 0, t1: 6, c0: 0, c1: 2 },
        { t0: 7, t1: 12, c0: 2, c1: 4 },
      ],
      paddedDurations,
      100,
      '你好世界',
    );
    expect(marks).toEqual([
      // Leading pad = 2 frames = 50ms + 100ms offset -> 150ms; 6 tokens sum = 3+3+2+4+4+2 = 18 frames = 450ms
      { start: 0, end: 2, timeMs: 150, durationMs: 450, word: '你好' },
      // Token 6 ('/') = 1 frame = 25ms -> starts at 150 + 450 + 25 = 625ms; 5 tokens sum = 5+5+3+3+2 = 18 frames = 450ms
      { start: 2, end: 4, timeMs: 625, durationMs: 450, word: '世界' },
    ]);
  });
});

describe('QwenSpeechProvider, concatWav, SynthScheduler & Cache Keys (§2, §6)', () => {
  function makeTestWav(samples: readonly number[], sampleRate = 24_000): Uint8Array {
    return encodeMonoPcm16Wav(samples, sampleRate, { minPeak: 0.001 }).wav;
  }

  it('stitches multi-chunk PCM16 WAVs losslessly with concatWav and rejects incompatible headers', () => {
    const wav1 = makeTestWav([0.1, -0.2, 0.3, -0.4], 24_000);
    const wav2 = makeTestWav([0.5, -0.5, 0.25], 24_000);
    const merged = concatWav([wav1, wav2]);

    const parsed = parseWav(merged.wav);
    expect(parsed.sampleRate).toBe(24_000);
    expect(parsed.numChannels).toBe(1);
    expect(parsed.bitsPerSample).toBe(16);
    expect(parsed.pcmBytes.byteLength).toBe((4 + 3) * 2);

    const wav48k = makeTestWav([0.2, -0.2], 48_000);
    expect(() => concatWav([wav1, wav48k])).toThrow(MiniBookError);
  });

  it('drives mlx-audio, vllm-omni, and qwen-native (>30s split + concatWav) wire protocols accurately', async () => {
    const captured: TransportHttpRequest[] = [];
    const wavChunk = makeTestWav(new Array(2400).fill(0.2), 24_000); // 100ms WAV

    const http: HttpTransport = async (req) => {
      captured.push(req);
      if (req.url.endsWith('/v1/audio/voices?model=mlx-community%2FKokoro-82M-bf16')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(
            JSON.stringify({ data: [{ id: 'zf_xiaoxiao', name: 'Xiaoxiao' }] }),
          ),
        };
      }
      if (req.url.endsWith('/health')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify({ status: 'healthy' })),
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
        body: wavChunk,
      };
    };

    const provider = new QwenSpeechProvider({ http });

    // 1. mlx-audio Qwen3 CustomVoice
    const mlxCfg: QwenServerConfig = {
      baseUrl: 'http://192.168.1.20:8000/',
      protocol: 'mlx-audio',
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',
      voice: 'Vivian',
      instruct: 'calm narrator',
    };
    const mlxVoices = await provider.listVoices({ config: mlxCfg });
    expect(mlxVoices.some((v) => v.id === 'Vivian' && v.provider === 'qwen')).toBe(true);

    const mlxOut = await provider.synthesize({
      config: mlxCfg,
      text: '你好，世界。',
      lang: 'zh-CN',
    });
    expect(mlxOut.mime).toBe('audio/wav');
    const mlxBody = JSON.parse(captured[0]!.body as string) as Record<string, unknown>;
    expect(captured[0]!.url).toBe('http://192.168.1.20:8000/v1/audio/speech');
    expect(mlxBody).toMatchObject({
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16',
      input: '你好，世界。',
      voice: 'Vivian',
      lang_code: 'chinese',
      instruct: 'calm narrator',
      response_format: 'wav',
    });

    // mlx-audio Kokoro preset voice listing via `?model=`
    const mlxKokoroVoices = await provider.listVoices({
      config: { ...mlxCfg, model: 'mlx-community/Kokoro-82M-bf16', voice: 'zf_xiaoxiao' },
    });
    expect(mlxKokoroVoices).toEqual([
      {
        id: 'zf_xiaoxiao',
        provider: 'qwen',
        name: 'Xiaoxiao',
        lang: 'und',
        quality: 'remote',
        local: false,
      },
    ]);

    // 2. vllm-omni
    const vllmCfg: QwenServerConfig = {
      baseUrl: 'http://10.0.0.5:8000',
      protocol: 'vllm-omni',
      model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      voice: 'Vivian',
      instruct: 'warm',
    };
    await provider.synthesize({ config: vllmCfg, text: 'Hello world.', lang: 'en-US' });
    const vllmReq = captured[captured.length - 1]!;
    expect(JSON.parse(vllmReq.body as string)).toMatchObject({
      voice: 'vivian',
      language: 'English',
      instructions: 'warm',
      response_format: 'wav',
    });

    // 3. qwen-native: missing refAudio throws invalid-argument
    await expect(
      provider.synthesize({
        config: {
          baseUrl: 'http://127.0.0.1:8000',
          protocol: 'qwen-native',
          model: '',
          voice: 'Cloned',
        },
        text: '测试',
      }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    // qwen-native >30s (>165 CJK chars @ 5.5 chars/s) splits & stitches via concatWav
    const longZh = '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'.repeat(10); // 240 chars (~43.6s)
    const pieces = splitForQwen(longZh);
    expect(pieces.length).toBeGreaterThanOrEqual(2);

    const beforeCount = captured.length;
    const nativeCfg: QwenServerConfig = {
      baseUrl: 'http://127.0.0.1:8000',
      protocol: 'qwen-native',
      model: '',
      voice: 'Cloned',
      refAudio: '/tmp/ref.wav',
      refText: '参考音频文本',
    };
    const nativeOut = await provider.synthesize({ config: nativeCfg, text: longZh });
    const synthCalls = captured.slice(beforeCount);
    expect(synthCalls.length).toBe(pieces.length);
    expect(synthCalls[0]!.url).toBe('http://127.0.0.1:8000/synthesize');
    expect(parseWav(nativeOut.audio).pcmBytes.byteLength).toBe(
      pieces.length * parseWav(wavChunk).pcmBytes.byteLength,
    );
    expect(await provider.checkHealth({ baseUrl: 'http://127.0.0.1:8000', protocol: 'qwen-native' })).toBe(
      true,
    );
  });

  it('forwards phonemeIds/phonemeSpeeds/phonemeSpans in SynthScheduler with maxConcurrency=1 and versions cache keys', async () => {
    const k1 = computeSpeechCacheKeySync({
      engine: 'kokoro',
      voiceId: 'zf_001',
      text: '你好',
      variant: 'onnx-fp32',
    });
    const k2 = computeSpeechCacheKeySync({
      engine: 'kokoro',
      voiceId: 'zf_001',
      text: '你好',
      variant: 'onnx-q8',
    });
    expect(k1).not.toBe(k2);
    expect(computeKokoroModelCacheTag('onnx-fp32')).toBe(`v1.1-zh|onnx-fp32|g2p${KOKORO_G2P_VERSION}`);

    const qTagA = computeQwenModelCacheTag({
      baseUrl: 'http://localhost:8000',
      protocol: 'qwen-native',
      model: '',
      voice: 'Clone',
      refAudio: 'a.wav',
    });
    const qTagB = computeQwenModelCacheTag({
      baseUrl: 'http://localhost:8000',
      protocol: 'qwen-native',
      model: '',
      voice: 'Clone',
      refAudio: 'b.wav',
    });
    expect(qTagA).not.toBe(qTagB);

    const seenReqs: unknown[] = [];
    let activeInFlight = 0;
    let maxObservedInFlight = 0;

    const scheduler = new SynthScheduler({
      synthesize: async (req) => {
        seenReqs.push(req);
        activeInFlight++;
        maxObservedInFlight = Math.max(maxObservedInFlight, activeInFlight);
        await new Promise((r) => setTimeout(r, 10));
        activeInFlight--;
        return {
          ref: 'blob:kokoro-1',
          mime: 'audio/wav',
          durationMs: 2000,
          synthMs: 200,
          bytes: 96_044,
        };
      },
      attachAudio: () => {},
    });

    scheduler.configure({ engine: 'kokoro', voiceId: 'zf_001' });
    expect(scheduler.getEffectiveConcurrency()).toBe(1);

    const u1: Utterance = {
      id: '0:0-3',
      section: 0,
      start: 0,
      end: 3,
      blockIndex: 0,
      text: '你好。',
      lang: 'zh-CN',
      pauseAfterMs: 220,
      phonemeIds: [[73, 127, 172, 88, 108, 169, 4]],
      phonemeSpeeds: [1.1],
      phonemeSpans: [[{ t0: 0, t1: 6, c0: 0, c1: 2 }]],
    };
    const u2: Utterance = {
      ...u1,
      id: '0:3-6',
      start: 3,
      end: 6,
    };

    scheduler.setQueue([u1, u2], u1.id);
    await new Promise((r) => setTimeout(r, 40));
    scheduler.dispose();

    expect(maxObservedInFlight).toBe(1);
    expect(seenReqs.length).toBe(2);
    expect(seenReqs[0]).toMatchObject({
      engine: 'kokoro',
      voiceId: 'zf_001',
      phonemeIds: [[73, 127, 172, 88, 108, 169, 4]],
      phonemeSpeeds: [1.1],
      phonemeSpans: [[{ t0: 0, t1: 6, c0: 0, c1: 2 }]],
    });
  });
});
