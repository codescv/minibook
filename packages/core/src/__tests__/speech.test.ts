import { describe, expect, it, vi } from 'vitest';
import {
  EdgeSpeechProvider,
  MiniBookError,
  OpenAiSpeechProvider,
  PAUSE_HEADING_MS,
  PAUSE_PARAGRAPH_MS,
  PAUSE_SECTION_END_MS,
  PAUSE_SENTENCE_MS,
  SynthScheduler,
  buildSectionText,
  computeSecMsGecToken,
  computeSpeechCacheKeySync,
  findAdjacentParagraphUtterance,
  parseHtmlFragment,
  segmentSection,
} from '../index.js';
import type { AttachedAudio, SectionText, SocketHandlers, SynthResult, Utterance } from '../types.js';

function makeSectionTextFromHtml(html: string, defaultLang: string | null = 'en'): SectionText {
  const nodes = parseHtmlFragment(html);
  return buildSectionText(nodes, defaultLang);
}

function makeSimpleWav(durationSec: number, sampleRate = 24000): Uint8Array {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataBytes = numSamples * 2; // 16-bit mono
  const buf = new Uint8Array(44 + dataBytes);
  const v = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode('RIFF'), 0);
  v.setUint32(4, 36 + dataBytes, true);
  buf.set(new TextEncoder().encode('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byteRate
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  buf.set(new TextEncoder().encode('data'), 36);
  v.setUint32(40, dataBytes, true);
  return buf;
}

describe('Sentence Segmenter, SynthScheduler & Edge/OpenAI Speech Providers', () => {
  it('segments Chinese dialogue, English abbreviations/decimals, Japanese quotes, mixed zh/en, and enforces strict slice invariants', () => {
    const html = `
      <h1>第一章 晨雾与钟声</h1>
      <p>“嗯。”少年轻声应道。“今天山里的雾真大啊！”他抬头望向远方，心中暗想：“好！出发吧！”随后迈步走下石阶。</p>
      <p lang="en">Dr. Manette met Mr. Lorry at St. Antoine at 3.14 p.m. in Vol. 1. "Shall we proceed?" she asked quietly.</p>
      <p lang="ja">「吾輩は猫である。」と彼は笑った。名前はまだ無い……本当だろうか？！</p>
      <p>在现代 WebKit 与 Chromium 渲染引擎中，CSS Multi-Column 布局能够实现精确的分页。</p>
    `;
    const sectionText = makeSectionTextFromHtml(html, 'zh-CN');
    const utterances = segmentSection(0, sectionText, { bookLang: 'zh-CN' });

    expect(utterances.length).toBeGreaterThanOrEqual(7);
    for (const u of utterances) {
      expect(u.text).toBe(sectionText.text.slice(u.start, u.end));
    }

    // Heading pause = 800ms
    expect(utterances[0]?.text).toBe('第一章 晨雾与钟声');
    expect(utterances[0]?.pauseAfterMs).toBe(PAUSE_HEADING_MS);

    // Short `< 6`-char `"“嗯。”"` merged into `"少年轻声应道。"` without breaking slice invariant!
    expect(utterances[1]?.text).toBe('“嗯。”少年轻声应道。');
    expect(utterances[1]?.pauseAfterMs).toBe(PAUSE_SENTENCE_MS);

    // Closing quote stays with `"“今天山里的雾真大啊！”"`
    expect(utterances[2]?.text).toBe('“今天山里的雾真大啊！”');

    // Short inner quote `"“好！出发吧！”"` (< 12 chars) is NOT split at the inner `！`,
    // while its closing quote stays attached before the trailing clause (`§8.1 #4`)!
    expect(utterances[3]?.text).toBe('他抬头望向远方，心中暗想：“好！出发吧！”');
    expect(utterances[4]?.text).toBe('随后迈步走下石阶。');
    expect(utterances[4]?.pauseAfterMs).toBe(PAUSE_PARAGRAPH_MS);

    // English abbreviations (`Dr.`, `Mr.`, `St.`, `3.14`, `Vol.`) NOT split!
    const enUtterances = utterances.filter((u) => u.lang === 'en');
    expect(enUtterances[0]?.text).toBe(
      'Dr. Manette met Mr. Lorry at St. Antoine at 3.14 p.m. in Vol. 1.',
    );
    expect(enUtterances[1]?.text).toBe('"Shall we proceed?" she asked quietly.');

    // Japanese `「」` (quoted sentence + attribution per §8.1 #4) and `……` / `？！` runs
    const jaUtterances = utterances.filter((u) => u.lang === 'ja');
    expect(jaUtterances[0]?.text).toBe('「吾輩は猫である。」');
    expect(jaUtterances[1]?.text).toBe('と彼は笑った。');
    expect(jaUtterances[2]?.text).toBe('名前はまだ無い……');
    expect(jaUtterances[3]?.text).toBe('本当だろうか？！');

    // Mixed zh/en technical sentence NOT split by script; spoken by CJK voice; section end = 1200ms
    const last = utterances[utterances.length - 1]!;
    expect(last.text).toBe('在现代 WebKit 与 Chromium 渲染引擎中，CSS Multi-Column 布局能够实现精确的分页。');
    expect(last.lang).toBe('zh-CN');
    expect(last.pauseAfterMs).toBe(PAUSE_SECTION_END_MS);

    // Paragraph navigation (`⏮` / `⏭` long-press)
    const nextPara = findAdjacentParagraphUtterance(utterances, utterances[1]!.id, 1);
    expect(nextPara?.id).toBe(enUtterances[0]!.id);
    const prevPara = findAdjacentParagraphUtterance(utterances, enUtterances[1]!.id, -1);
    expect(prevPara?.id).toBe(utterances[1]!.id);

    // > 200 CJK char long sentence clause-splitting + mid-book > 80 char first-utterance split
    const longCjk = '春风拂过山岗，' + '溪水潺潺流淌，林间鸟鸣婉转，云霞映照着古老的石桥，'.repeat(12) + '终于抵达了山顶。';
    const longSt = makeSectionTextFromHtml(`<p>${longCjk}</p>`, 'zh-CN');
    const splitLong = segmentSection(2, longSt, { bookLang: 'zh-CN' });
    expect(splitLong.length).toBeGreaterThanOrEqual(2);
    for (const u of splitLong) {
      expect(u.text.length).toBeLessThanOrEqual(200);
      expect(u.text).toBe(longSt.text.slice(u.start, u.end));
    }

    const midBook = segmentSection(2, longSt, {
      bookLang: 'zh-CN',
      startOffset: 8,
      splitFirstLongUtterance: true,
    });
    expect(midBook[0]!.text.length).toBeLessThanOrEqual(120);
    expect(midBook[0]!.text).toBe(longSt.text.slice(midBook[0]!.start, midBook[0]!.end));
  });

  it('schedules lookahead prefetch, detects single-flight lock servers, flags slow RTF >= 0.9, and uses ZERO timers when hidden', async () => {
    const sampleQueue: Utterance[] = Array.from({ length: 8 }, (_, idx) => ({
      id: `0:${idx * 50}-${idx * 50 + 40}`,
      section: 0,
      start: idx * 50,
      end: idx * 50 + 40,
      blockIndex: idx,
      text: `Sentence number ${idx + 1} with forty characters.`,
      lang: 'en',
      pauseAfterMs: 200,
    }));

    // 1. Fast engine (`RTF = 0.2`, 10s audio each -> stops prefetching once 3 utterances = 30s ahead!)
    const attachedFast: Array<{ id: string; audio: AttachedAudio }> = [];
    let maxSimultaneousFast = 0;
    let curInFlightFast = 0;
    let firstFetchWasSolo = false;
    let callNumFast = 0;
    const slowCallbacksFast: number[] = [];

    const fastScheduler = new SynthScheduler({
      synthesize: async (req) => {
        callNumFast++;
        curInFlightFast++;
        if (callNumFast === 1) {
          firstFetchWasSolo = curInFlightFast === 1;
        }
        maxSimultaneousFast = Math.max(maxSimultaneousFast, curInFlightFast);
        await new Promise((r) => setTimeout(r, 5));
        curInFlightFast--;
        const result: SynthResult = {
          ref: `/audio/${computeSpeechCacheKeySync(req)}`,
          mime: 'audio/mpeg',
          durationMs: 10_000,
          synthMs: 2_000, // RTF = 0.2
          bytes: 60_000,
        };
        return result;
      },
      attachAudio: (id, audio) => attachedFast.push({ id, audio }),
      onEngineSlow: ({ rtf }) => slowCallbacksFast.push(rtf),
      isHidden: () => false,
    });

    fastScheduler.configure({ engine: 'edge', voiceId: 'en-US-AvaMultilingualNeural' });
    fastScheduler.setQueue(sampleQueue, sampleQueue[0]!.id);

    await vi.waitFor(() => {
      expect(attachedFast.length).toBeGreaterThanOrEqual(3);
    });
    expect(firstFetchWasSolo).toBe(true);
    expect(maxSimultaneousFast).toBeLessThanOrEqual(2);
    expect(attachedFast.length).toBeLessThanOrEqual(4); // Stopped at 30s target ahead!
    expect(slowCallbacksFast).toHaveLength(0);
    fastScheduler.dispose();

    // 2. Qwen CPU box simulation (`RTF = 4.5`, single-flight lock serializing overlapping requests):
    //    Starts at concurrency 2, detects lock -> drops `effectiveConcurrency` to 1, and emits `onEngineSlow` after 2nd utterance!
    let slowFired: { rtf: number; engine: string } | null = null;
    let qwenCall = 0;
    const qwenScheduler = new SynthScheduler({
      synthesize: async (_req) => {
        qwenCall++;
        await new Promise((r) => setTimeout(r, qwenCall === 3 ? 12 : 4));
        // Call 1 (solo): synthMs = 4500ms for 1000ms audio (RTF 4.5).
        // Call 2 & 3 (overlapping behind lock): call 3 waited behind call 2 -> synthMs = 9000ms (~2x solo)!
        const synthMs = qwenCall === 3 ? 9_000 : 4_500;
        return {
          ref: `/qwen/${qwenCall}.wav`,
          mime: 'audio/wav',
          durationMs: 1_000,
          synthMs,
          bytes: 48_000,
        };
      },
      attachAudio: () => {},
      onEngineSlow: (info) => {
        slowFired = info;
      },
      isHidden: () => false,
    });

    qwenScheduler.configure({ engine: 'openai', voiceId: 'clone', model: 'qwen3-tts' });
    qwenScheduler.setQueue(sampleQueue.slice(0, 4), sampleQueue[0]!.id);

    await vi.waitFor(() => {
      expect(qwenCall).toBeGreaterThanOrEqual(3);
    });
    expect(qwenScheduler.getEffectiveConcurrency()).toBe(1);
    expect(slowFired).not.toBeNull();
    expect(slowFired!.rtf).toBeGreaterThan(4.0);
    qwenScheduler.dispose();

    // 3. Hidden WebView ZERO-timer guarantee + abort-on-seek
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const initialTimeoutCount = setTimeoutSpy.mock.calls.length;
    let hiddenAttempts = 0;
    let hiddenSucceeded = false;

    const hiddenScheduler = new SynthScheduler({
      synthesize: async (_req, signal) => {
        hiddenAttempts++;
        if (signal.aborted) throw new MiniBookError('cancelled', 'aborted');
        if (hiddenAttempts === 1) {
          throw new MiniBookError('network', 'transient glitch while screen off');
        }
        return {
          ref: '/ok.mp3',
          mime: 'audio/mpeg',
          durationMs: 125_000, // satisfies 120s hidden target in 1 utterance
          synthMs: 400,
          bytes: 1000,
        };
      },
      attachAudio: () => {
        hiddenSucceeded = true;
      },
      isHidden: () => true,
    });

    hiddenScheduler.configure({ engine: 'edge', voiceId: 'zh-CN-XiaoxiaoNeural' });
    hiddenScheduler.setQueue([sampleQueue[0]!], sampleQueue[0]!.id);

    await vi.waitFor(() => {
      expect(hiddenSucceeded).toBe(true);
    });
    expect(hiddenAttempts).toBe(2);
    // ZERO `setTimeout` calls were made by `SynthScheduler` during hidden retry!
    expect(setTimeoutSpy.mock.calls.length).toBe(initialTimeoutCount);
    setTimeoutSpy.mockRestore();
    hiddenScheduler.dispose();
  });

  it('speaks Edge Read-Aloud WebSocket frames + WordBoundary marks and OpenAI /v1/audio/speech WAV/MP3', async () => {
    const fixedNow = 1_763_000_000_000;
    const token = computeSecMsGecToken(fixedNow);
    expect(token).toMatch(/^[0-9A-F]{64}$/);

    const sentFrames: string[] = [];
    const edgeProvider = new EdgeSpeechProvider({
      now: () => fixedNow,
      http: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(
          JSON.stringify([
            {
              ShortName: 'zh-CN-XiaoxiaoNeural',
              FriendlyName: 'Microsoft Xiaoxiao Online (Natural)',
              Locale: 'zh-CN',
            },
          ]),
        ),
      }),
      socket: async (opts, handlers: SocketHandlers) => {
        expect(opts.url).toContain(`Sec-MS-GEC=${token}`);
        expect(opts.headers?.['Origin']).toContain('chrome-extension://');
        return {
          sendText(t: string) {
            sentFrames.push(t);
            if (t.includes('Path:ssml')) {
              queueMicrotask(() => {
                // Emit WordBoundary metadata frame (100-ns ticks: 1_500_000 = 150ms, 4_000_000 = 400ms)
                handlers.onMessage({
                  kind: 'text',
                  text:
                    'Path:audio.metadata\r\nContent-Type:application/json\r\n\r\n' +
                    JSON.stringify({
                      Metadata: [
                        { Type: 'WordBoundary', Data: { Offset: 1_500_000, Duration: 2_500_000, text: { Text: 'Hello' } } },
                        { Type: 'WordBoundary', Data: { Offset: 4_500_000, Duration: 3_000_000, text: { Text: 'world' } } },
                      ],
                    }),
                });
                // Emit binary audio frame (`2-byte BE header len` + `Path:audio\r\n` + fake MP3 bytes)
                const hdr = new TextEncoder().encode('Path:audio\r\n');
                const mp3Payload = new Uint8Array(6000).fill(0x55);
                const binFrame = new Uint8Array(2 + hdr.length + mp3Payload.length);
                binFrame[0] = (hdr.length >>> 8) & 0xff;
                binFrame[1] = hdr.length & 0xff;
                binFrame.set(hdr, 2);
                binFrame.set(mp3Payload, 2 + hdr.length);
                handlers.onMessage({ kind: 'binary', bytes: binFrame });
                handlers.onMessage({ kind: 'text', text: 'Path:turn.end\r\n\r\n' });
              });
            }
          },
          sendBinary() {},
          close() {},
        };
      },
    });

    const voices = await edgeProvider.listVoices();
    expect(voices).toHaveLength(1);
    expect(voices[0]?.id).toBe('zh-CN-XiaoxiaoNeural');

    const synth = await edgeProvider.synthesize({
      voiceId: 'en-US-AvaMultilingualNeural',
      text: 'Hello <world>!',
      lang: 'en-US',
    });
    expect(sentFrames.some((f) => f.includes('Hello &lt;world&gt;!'))).toBe(true);
    expect(synth.mime).toBe('audio/mpeg');
    expect(synth.audio.byteLength).toBe(6000);
    expect(synth.marks).toEqual([
      { start: 0, end: 5, timeMs: 150, durationMs: 250, word: 'Hello' },
      { start: 7, end: 12, timeMs: 450, durationMs: 300, word: 'world' },
    ]);

    // Edge HTTP 403 -> `speech-auth`
    const edge403 = new EdgeSpeechProvider({
      http: async () => ({ status: 403, headers: {}, body: new Uint8Array(0) }),
      socket: async () => {
        throw new Error('Unexpected server response: 403 Forbidden');
      },
    });
    await expect(
      edge403.synthesize({ voiceId: 'en-US-AvaMultilingualNeural', text: 'Test' }),
    ).rejects.toMatchObject({ code: 'speech-auth' });

    // OpenAI-compatible provider with WAV response (2.5s WAV -> `durationMs === 2500`!)
    const wavBytes = makeSimpleWav(2.5, 24000);
    let capturedUrl = '';
    let capturedAuth = '';
    const openAi = new OpenAiSpeechProvider({
      http: async (req) => {
        capturedUrl = req.url;
        capturedAuth = req.headers?.['Authorization'] ?? '';
        return {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
          body: wavBytes,
        };
      },
    });
    const wavOut = await openAi.synthesize({
      baseUrl: 'http://192.168.1.50:8880',
      model: 'kokoro',
      voiceId: 'af_heart',
      text: 'Testing Kokoro LAN endpoint.',
      apiKeyHeader: '{{secret:custom-speech-api-key}}',
    });
    expect(capturedUrl).toBe('http://192.168.1.50:8880/v1/audio/speech');
    expect(capturedAuth).toBe('Bearer {{secret:custom-speech-api-key}}');
    expect(wavOut.mime).toBe('audio/wav');
    expect(wavOut.durationMs).toBe(2500);
  });
});
