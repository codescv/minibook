import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  KOKORO_VOICE_BIN_BYTES,
  KOKORO_VOICE_DIM,
  parseWav,
} from '@minibook/core';
import {
  AutoPageTurn,
  createMockPlatformHost,
  createMockSpeechPlayer,
  KokoroG2PClient,
  KokoroWebEngine,
  ReadAloudController,
  RefreshController,
  sliceKokoroVoiceStyle,
  useReadAloudStore,
  useSpeechModelStore,
  WebSpeechPlayer,
  type MinimalWorkerLike,
  type OrtRuntimeLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from '../index';

describe('ReadAloudController, Single-Book Rule, 8s Fallback & RefreshController', () => {
  it('starts playback, enforces one-book-at-a-time rule, and follows 600ms manual page turns', async () => {
    vi.useFakeTimers();
    try {
      const host = createMockPlatformHost();
      const player = createMockSpeechPlayer();
      const ctl = new ReadAloudController({
        host,
        player,
        getSettings: () => DEFAULT_APP_SETTINGS,
        getIsEink: () => false,
      });

      await ctl.start({
        bookId: 'b_dickens',
        startLocator: { section: 0, offset: 0 },
      });

      expect(useReadAloudStore.getState().active).toBe(true);
      expect(useReadAloudStore.getState().bookId).toBe('b_dickens');
      // Pre-stocks Section 0 + Section 1!
      const queuedSections = new Set(player.getQueue().map((u) => u.section));
      expect(queuedSections.has(0)).toBe(true);
      expect(queuedSections.has(1)).toBe(true);

      // Manual page turn moves voice after 600ms settle
      const sec1First = player.getQueue().find((u) => u.section === 1)!;
      ctl.notifyManualPageTurn({ section: 1, offset: sec1First.start });
      vi.advanceTimersByTime(590);
      expect(useReadAloudStore.getState().activeUtterance?.section).toBe(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(useReadAloudStore.getState().activeUtterance?.section).toBe(1);

      // Re-opening SAME book keeps session alive
      ctl.onBookOpened('b_dickens');
      expect(useReadAloudStore.getState().active).toBe(true);

      // Opening a DIFFERENT book stops the session immediately (`PRODUCT_DESIGN.md` §6)
      ctl.onBookOpened('b_luxun');
      expect(useReadAloudStore.getState().active).toBe(false);
      expect(useReadAloudStore.getState().bookId).toBeNull();

      ctl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces RTF >= 0.9 slow-voice warning from SynthScheduler', async () => {
    const host = createMockPlatformHost({ synthDelayMs: 5, synthRtf: 4.5 });
    const player = createMockSpeechPlayer();
    const settings = {
      ...DEFAULT_APP_SETTINGS,
      customSpeechServer: { baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen', voice: 'Qwen' },
      preferredVoices: {
        en: { kind: 'openai' as const, voiceId: 'Qwen', model: 'qwen' },
      },
    };

    const ctl = new ReadAloudController({
      host,
      player,
      getSettings: () => settings,
      getIsEink: () => false,
    });

    await ctl.start({
      bookId: 'b_dickens',
      startLocator: { section: 0, offset: 0 },
    });

    await vi.waitFor(() => {
      expect(useReadAloudStore.getState().slowVoiceRtf).toBeGreaterThanOrEqual(4.0);
    });

    ctl.dispose();
  });

  it('implements WebSpeechPlayer 8s paragraph-sticky system fallback (§8.5)', async () => {
    vi.useFakeTimers();
    try {
      const webPlayer = new WebSpeechPlayer({
        bufferingTimeoutOnlineMs: 500,
        bufferingTimeoutOfflineMs: 200,
      });
      const events: string[] = [];
      webPlayer.subscribe((e) => {
        events.push(
          e.type === 'utterance-start'
            ? `${e.type}:${e.id}:fb=${Boolean(e.usingFallback)}`
            : e.type,
        );
      });

      await webPlayer.load({
        bookId: 'b_dickens',
        title: 'Book',
        author: 'Author',
        chapterTitle: 'Ch 1',
        voice: { kind: 'edge', voiceId: 'en-US-AvaMultilingualNeural' },
        systemFallback: { kind: 'system', voiceId: null },
        rate: 1.0,
      });

      webPlayer.enqueue([
        {
          id: '0:0-10',
          section: 0,
          start: 0,
          end: 10,
          blockIndex: 0,
          text: 'Sentence 1',
          lang: 'en',
          pauseAfterMs: 50,
        },
        {
          id: '0:11-21',
          section: 0,
          start: 11,
          end: 21,
          blockIndex: 0,
          text: 'Sentence 2',
          lang: 'en',
          pauseAfterMs: 50,
        },
      ]);

      webPlayer.play();
      expect((await webPlayer.getState()).status).toBe('buffering');

      // Advance past buffering timeout -> falls back to system voice & stays sticky for block 0
      vi.advanceTimersByTime(520);
      expect(events).toContain('speech-fallback');
      expect(events).toContain('utterance-start:0:0-10:fb=true');

      // Finish sentence 1 + gap -> sentence 2 in SAME blockIndex=0 stays on fallback without re-buffering!
      vi.advanceTimersByTime(1000);
      expect(events).toContain('utterance-start:0:11-21:fb=true');

      webPlayer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('executes mutually exclusive vendor vs pre-swap software flash in RefreshController (§9.4)', async () => {
    const trace: string[] = [];
    const vendorHost = createMockPlatformHost({
      platform: 'android',
      capabilities: { vendorRefresh: true, einkDetected: true },
    });

    const vendorCtl = new RefreshController({
      host: vendorHost,
      setFlashPhase: (p) => trace.push(`flash:${p ?? 'off'}`),
      blackHoldMs: 1,
      whiteHoldMs: 1,
      waitPaint: async () => {
        trace.push('paint');
      },
      sleep: async () => {},
    });

    // Turn 1..4 (< cadence 5): plain swap only
    for (let i = 0; i < 4; i++) {
      await vendorCtl.runTurn({
        isEink: true,
        cadence: 5,
        swap: () => {
          trace.push(`swap:${i + 1}`);
        },
      });
    }
    expect(vendorHost.fullRefreshCallCount).toBe(0);
    expect(trace.some((t) => t.startsWith('flash:'))).toBe(false);

    // Turn 5: vendor refresh succeeds -> swaps first, paints, calls native fullRefresh, ZERO FlashOverlay!
    trace.length = 0;
    await vendorCtl.runTurn({
      isEink: true,
      cadence: 5,
      swap: () => {
        trace.push('swap:5');
      },
    });
    expect(vendorHost.fullRefreshCallCount).toBe(1);
    expect(trace).toEqual(['swap:5', 'paint']);

    // Software flash controller (`vendorRefresh: false`): mounts #000 BEFORE swap!
    const swTrace: string[] = [];
    const swHost = createMockPlatformHost({
      platform: 'android',
      capabilities: { vendorRefresh: false, einkDetected: true },
    });
    const swCtl = new RefreshController({
      host: swHost,
      setFlashPhase: (p) => swTrace.push(`flash:${p ?? 'off'}`),
      blackHoldMs: 1,
      whiteHoldMs: 1,
      waitPaint: async () => {
        swTrace.push('paint');
      },
      sleep: async () => {},
    });

    await swCtl.runTurn({
      isEink: true,
      cadence: 5,
      userPressedRefresh: true,
      swap: () => {
        swTrace.push('swap');
      },
    });

    // Proof that solid #000000 went up BEFORE swap, then #FFFFFF, then off!
    expect(swTrace).toEqual([
      'flash:black',
      'paint',
      'swap',
      'flash:white',
      'flash:off',
    ]);

    // Cadence Off (`0`): suppresses periodic & tall-sheet refreshes, while manual ⟳ button still works on demand (`#43 P2-a`)
    swTrace.length = 0;
    await swCtl.runTurn({
      isEink: true,
      cadence: 0,
      closedSheetCoveredHalfScreen: true,
      swap: () => {
        swTrace.push('swap-off');
      },
    });
    expect(swTrace).toEqual(['swap-off']);

    swTrace.length = 0;
    await swCtl.runTurn({
      isEink: true,
      cadence: 0,
      userPressedRefresh: true,
      swap: () => {
        swTrace.push('swap-manual');
      },
    });
    expect(swTrace).toEqual([
      'flash:black',
      'paint',
      'swap-manual',
      'flash:white',
      'flash:off',
    ]);

    // Concurrent calls during flash serialize cleanly without overlapping overlays
    swTrace.length = 0;
    let releaseHold!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const serialCtl = new RefreshController({
      host: swHost,
      setFlashPhase: (p) => swTrace.push(`flash:${p ?? 'off'}`),
      blackHoldMs: 1,
      whiteHoldMs: 1,
      waitPaint: async () => {
        swTrace.push('paint');
      },
      sleep: async (ms) => {
        if (ms === 1 && !swTrace.includes('flash:white')) {
          await holdPromise;
        }
      },
    });

    const p1 = serialCtl.runTurn({
      isEink: true,
      cadence: 5,
      closedSheetCoveredHalfScreen: true,
      swap: () => {
        swTrace.push('swap:A');
      },
    });
    const p2 = serialCtl.runTurn({
      isEink: true,
      cadence: 5,
      swap: () => {
        swTrace.push('swap:B');
      },
    });

    // Wait for A to reach black hold; B must NOT have swapped yet!
    await Promise.resolve();
    await Promise.resolve();
    expect(swTrace).toEqual(['flash:black', 'paint', 'swap:A']);
    releaseHold();
    await Promise.all([p1, p2]);
    expect(swTrace).toEqual([
      'flash:black',
      'paint',
      'swap:A',
      'flash:white',
      'flash:off',
      'swap:B',
    ]);
  });

  it('[P1-U3] advances across >40k virtual render unit boundaries in AutoPageTurn', () => {
    vi.useFakeTimers();
    try {
      const apt = new AutoPageTurn();
      let jumpedTo: { section: number; offset: number } | null = null;
      const adapter = {
        visibleSection: 0,
        visibleUnitRange: { start: 0, end: 40_000 },
        currentPage: () => 54,
        pageOf: () => 54,
        countCharsOnPage: () => 25,
        goToPage: () => {},
        jumpToLocator: (loc: { section: number; offset: number }) => {
          jumpedTo = loc;
        },
      };

      // Utterance starting in unit 1 (offset 40010 >= unit.end 40000) triggers jumpToLocator immediately
      apt.onUtteranceStart(
        {
          id: '0:40010-40060',
          section: 0,
          start: 40_010,
          end: 40_060,
          blockIndex: 180,
          text: 'Next render unit sentence.',
          lang: 'en',
          pauseAfterMs: 200,
        },
        adapter,
        { rate: 1.0 },
      );
      expect(jumpedTo).toEqual({ section: 0, offset: 40_010 });

      // Utterance straddling unit 0 -> unit 1 boundary ([39975, 40025)) jumps proportionally to 40000
      jumpedTo = null;
      apt.onUtteranceStart(
        {
          id: '0:39975-40025',
          section: 0,
          start: 39_975,
          end: 40_025,
          blockIndex: 179,
          text: 'x'.repeat(50),
          lang: 'en',
          pauseAfterMs: 200,
        },
        adapter,
        { rate: 1.0, attachedDurationMs: 1000 },
      );
      vi.advanceTimersByTime(520);
      expect(jumpedTo).toEqual({ section: 0, offset: 40_000 });
      apt.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('[P1-U4, P1-U5, P2] picks first sentence BEGINNING on new page without backward snap, preserves contiguous spine order on backward jumps, and stocks >=25 across tiny sections', async () => {
    vi.useFakeTimers();
    try {
      // Build 16 tiny 32-char sections to verify horizon looping + backward jump spine continuity
      const tinySections = Array.from({ length: 16 }, (_, idx) => {
        const txt = `Tiny chapter ${idx + 1} has one line.`;
        return {
          title: `Ch ${idx + 1}`,
          xhtml: `<p>${txt}</p>`,
          lang: 'en',
          dir: 'ltr' as const,
          text: {
            text: txt,
            blocks: [{ start: 0, end: txt.length, kind: 'p' as const, lang: 'en' }],
          },
        };
      });

      const host = createMockPlatformHost({
        books: [
          {
            id: 'b_tiny16',
            meta: {
              title: 'Sixteen Short Chapters',
              authors: ['Anon'],
              language: 'en',
              identifier: 'tiny16',
              format: 'epub',
              direction: 'ltr',
              fixedLayout: false,
            },
            fileName: 'tiny16.epub',
            size: 4096,
            hasCover: false,
            addedAt: 1000,
            openedAt: 2000,
            finished: false,
            fraction: 0,
            toc: tinySections.map((s, idx) => ({
              title: s.title,
              locator: { section: idx, offset: 0 },
              children: [],
            })),
            sections: tinySections,
          },
        ],
      });

      const player = createMockSpeechPlayer();
      const ctl = new ReadAloudController({
        host,
        player,
        getSettings: () => DEFAULT_APP_SETTINGS,
        getIsEink: () => false,
      });

      // Start at section 5 -> stocks all remaining sections 5..15 in order!
      await ctl.start({
        bookId: 'b_tiny16',
        startLocator: { section: 5, offset: 0 },
      });
      expect(player.getQueue().map((u) => u.section)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

      // Jump BACKWARD to section 1 while speaking -> queue rebuilds contiguously [1, 2, 3, ..., 15] without skipping 2..5!
      ctl.notifyManualPageTurn({ section: 1, offset: 0 });
      await vi.advanceTimersByTimeAsync(620);
      expect(player.getQueue().map((u) => u.section)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ]);
      expect(useReadAloudStore.getState().activeUtterance?.section).toBe(1);
      ctl.dispose();

      // Verify [P1-U4]: turning onto page 1 where sentence 0 straddled from page 0 picks sentence 1 (beginning on page 1) and NEVER snaps back to page 0!
      const host2 = createMockPlatformHost();
      const player2 = createMockSpeechPlayer();
      const ctl2 = new ReadAloudController({
        host: host2,
        player: player2,
        getSettings: () => DEFAULT_APP_SETTINGS,
        getIsEink: () => false,
      });

      let currentPage = 0;
      await ctl2.start({
        bookId: 'b_dickens',
        startLocator: { section: 0, offset: 0 },
      });
      const sec0Queue = player2.getQueue().filter((u) => u.section === 0);
      expect(sec0Queue.length).toBeGreaterThanOrEqual(3);
      const u1 = sec0Queue[1]!; // e.g. starts at heading end = 13, ends ~430
      const u2 = sec0Queue[2]!; // starts ~430

      // Simulate u1 straddling from Page 0 onto Page 1 (Page 1 starts mid-u1 at u1.start + 60, u2 begins on Page 1)
      const midU1 = u1.start + 60;
      const page2Start = u2.end + 50;
      ctl2.attachViewAdapter({
        visibleSection: 0,
        visibleUnitRange: { start: 0, end: 5000 },
        currentPage: () => currentPage,
        pageOf: (off) => (off < midU1 ? 0 : off < page2Start ? 1 : 2),
        countCharsOnPage: () => 50,
        goToPage: (p) => {
          currentPage = p;
        },
        jumpToLocator: () => {},
      });

      // User manually turns to Page 1!
      currentPage = 1;
      ctl2.notifyManualPageTurn({ section: 0, offset: midU1 }, page2Start);
      await vi.advanceTimersByTimeAsync(620);

      // Voice picks u2 (the first sentence BEGINNING on Page 1) and stays on Page 1!
      expect(useReadAloudStore.getState().activeUtterance?.id).toBe(u2.id);
      expect(currentPage).toBe(1);

      ctl2.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('implements KokoroG2PClient Worker execution + sync throw, async onerror, and 2s WKWebView handshake timeout fallbacks (#66 Guardrail 1)', async () => {
    // 1. Dedicated Worker path when Worker posts `{ type: 'ready' }`
    const workerClient = new KokoroG2PClient({
      workerFactory: () => {
        const w: MinimalWorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg: any) {
            if (msg.type === 'init') {
              setTimeout(() => {
                w.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
              }, 5);
            } else if (msg.type === 'phonemize') {
              setTimeout(() => {
                w.onmessage?.({
                  data: {
                    type: 'result',
                    id: msg.id,
                    result: {
                      phonemes: 'ㄋㄧ2ㄏㄠ3.',
                      phonemeIds: [[73, 127, 172, 88, 108, 169, 4]],
                      phonemeSpeeds: [1.0],
                      phonemeSpans: [[{ t0: 0, t1: 6, c0: 0, c1: 2 }]],
                    },
                  },
                } as MessageEvent);
              }, 5);
            }
          },
          terminate() {},
        };
        return w;
      },
    });

    const wRes = await workerClient.phonemize('你好。', 'zh-CN', { voiceId: 'zf_001' });
    expect(workerClient.getExecutionMode()).toBe('worker-ready');
    expect(wRes.phonemeIds[0]).toEqual([73, 127, 172, 88, 108, 169, 4]);
    workerClient.dispose();

    // 2. Synchronous throw in `new Worker()` -> falls back to main-thread G2P with 0 errors
    const syncThrowClient = new KokoroG2PClient({
      workerFactory: () => {
        throw new Error('SecurityError: Worker blocked by origin');
      },
    });
    const syncRes = await syncThrowClient.phonemize('你好, world.', 'zh-CN', {
      voiceId: 'zf_001',
    });
    expect(syncThrowClient.getExecutionMode()).toBe('main');
    expect(syncRes.phonemeIds.length).toBeGreaterThan(0);
    expect(syncRes.phonemeIds[0]!.length).toBeGreaterThan(0);
    syncThrowClient.dispose();

    // 3. Asynchronous `worker.onerror` -> falls back to main-thread G2P and replays pending job seamlessly
    const asyncErrClient = new KokoroG2PClient({
      workerFactory: () => {
        const w: MinimalWorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage() {
            setTimeout(() => {
              w.onerror?.(new Error('WKWebView module worker load error'));
            }, 10);
          },
          terminate() {},
        };
        return w;
      },
    });
    const asyncRes = await asyncErrClient.phonemize('Hello world.', 'en-US', {
      voiceId: 'af_maple',
    });
    expect(asyncErrClient.getExecutionMode()).toBe('main');
    expect(asyncRes.phonemeIds.length).toBeGreaterThan(0);
    asyncErrClient.dispose();

    // 4. Silent hang in WKWebView (`capacitor://localhost`) -> 2s handshake timeout triggers main-thread G2P fallback!
    vi.useFakeTimers();
    try {
      let terminated = false;
      const hangClient = new KokoroG2PClient({
        handshakeTimeoutMs: 2000,
        workerFactory: () => ({
          onmessage: null,
          onerror: null,
          postMessage() {
            // Never responds (simulating WKWebView silent module Worker hang)
          },
          terminate() {
            terminated = true;
          },
        }),
      });

      const pendingPromise = hangClient.phonemize('春眠不觉晓, 处处闻啼鸟.', 'zh-CN', {
        voiceId: 'zf_001',
      });
      expect(hangClient.getExecutionMode()).toBe('worker-connecting');

      await vi.advanceTimersByTimeAsync(2050);
      const hangRes = await pendingPromise;
      expect(terminated).toBe(true);
      expect(hangClient.getExecutionMode()).toBe('main');
      expect(hangRes.phonemeIds.length).toBeGreaterThan(0);
      hangClient.dispose();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it('runs KokoroWebEngine load-time self-test, WebGPU -> WASM fallback, voice .bin row slicing, PCM16 WAV + WordMark[] synthesis, and RTF EMA >= 0.9 engine-slow (§5.1)', async () => {
    // Build a deterministic 522,240-byte voice .bin where row `r` has `style[0] = r + 0.5`
    const voiceBin = new Uint8Array(KOKORO_VOICE_BIN_BYTES);
    const dv = new DataView(voiceBin.buffer);
    for (let r = 0; r < 510; r++) {
      for (let d = 0; d < KOKORO_VOICE_DIM; d++) {
        dv.setFloat32((r * KOKORO_VOICE_DIM + d) * 4, r + (d === 0 ? 0.5 : 0.1), true);
      }
    }

    // Verify row = clamp(unpaddedLen - 1, 0, 509)
    expect(sliceKokoroVoiceStyle(voiceBin, 1)[0]).toBeCloseTo(0.5, 5);
    expect(sliceKokoroVoiceStyle(voiceBin, 7)[0]).toBeCloseTo(6.5, 5);
    expect(sliceKokoroVoiceStyle(voiceBin, 510)[0]).toBeCloseTo(509.5, 5);
    expect(sliceKokoroVoiceStyle(voiceBin, 999)[0]).toBeCloseTo(509.5, 5);

    const createdProviders: string[] = [];
    let simulatedClockMs = 1000;
    const slowEvents: number[] = [];

    const mockOrt: OrtRuntimeLike = {
      env: { wasm: {} },
      Tensor: class MockTensor implements OrtTensorLike {
        readonly type: string;
        readonly data: BigInt64Array | Float32Array;
        readonly dims: readonly number[];
        constructor(
          type: 'int64' | 'float32',
          data: BigInt64Array | Float32Array,
          dims: readonly number[],
        ) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
      InferenceSession: {
        async create(_modelBytes, opts): Promise<OrtSessionLike> {
          const ep = opts?.executionProviders?.[0] ?? 'wasm';
          createdProviders.push(ep);
          return {
            async run(feeds) {
              // Simulate WebGPU returning NaN on self-test so engine falls back to WASM!
              if (ep === 'webgpu') {
                const bad = new Float32Array(24_000);
                bad[10] = Number.NaN;
                return {
                  waveform: { data: bad, dims: [1, bad.length] },
                  duration: { data: new Float32Array([1, 5, 5, 5, 5, 5, 5, 5, 1]) },
                };
              }

              // Advance simulated clock by 1200ms per synthesis to trigger RTF >= 0.9
              simulatedClockMs += 1200;

              const inputIds = feeds.input_ids!.data as BigInt64Array;
              const nTokens = inputIds.length;
              // Each token gets 4 frames (4 * 600 = 2400 samples = 100ms @ 24kHz)
              const durations = new Float32Array(nTokens);
              durations.fill(4);
              const numSamples = Math.max(24_000, nTokens * 2400);
              const wave = new Float32Array(numSamples);
              for (let i = 0; i < numSamples; i++) {
                wave[i] = Math.sin((2 * Math.PI * 440 * i) / 24_000) * 0.25;
              }
              return {
                waveform: { data: wave, dims: [1, numSamples] },
                duration: { data: durations, dims: [1, nTokens] },
              };
            },
          };
        },
      },
    };

    const engine = new KokoroWebEngine({
      coreEnv: {
        loadOrt: async () => mockOrt,
        probeWebGpu: async () => true,
        fetchBinary: async (path) => {
          if (path.endsWith('.bin')) return voiceBin;
          return new Uint8Array([0x4f, 0x4e, 0x4e, 0x58]);
        },
        now: () => simulatedClockMs,
      },
      onEngineSlow: (ev) => {
        slowEvents.push(ev.rtf);
      },
    });

    const out = await engine.synthesize({
      engine: 'kokoro',
      voiceId: 'zf_001',
      text: '你好世界',
      lang: 'zh-CN',
      phonemeIds: [[73, 127, 172, 88, 108, 169]],
      phonemeSpeeds: [1.0],
      phonemeSpans: [
        [
          { t0: 0, t1: 3, c0: 0, c1: 2 },
          { t0: 3, t1: 6, c0: 2, c1: 4 },
        ],
      ],
    });

    // Probed WebGPU first, failed self-test on NaN, fell back to WASM cleanly!
    expect(createdProviders).toEqual(['webgpu', 'wasm']);
    expect(out.backend).toBe('wasm');

    // Valid 24 kHz mono PCM16 WAV + exact WordMark[] from phonemeSpans & durations
    const parsed = parseWav(out.wav);
    expect(parsed.sampleRate).toBe(24_000);
    expect(parsed.numChannels).toBe(1);
    expect(out.marks).toEqual([
      { start: 0, end: 2, timeMs: 100, durationMs: 300, word: '你好' },
      { start: 2, end: 4, timeMs: 400, durationMs: 300, word: '世界' },
    ]);
    expect(slowEvents.length).toBeGreaterThanOrEqual(1);
    expect(slowEvents[0]).toBeGreaterThanOrEqual(0.9);

    await engine.dispose();
  });

  it('annotates Utterances with phonemeIds/phonemeSpans in ReadAloudController and orders mid-session setVoice(kokoro) batches cleanly (§7.5)', async () => {
    const host = createMockPlatformHost({
      initialModelStatus: {
        state: 'ready',
        installedVoices: ['zf_001', 'af_maple'],
        bytesDone: 129_967_797,
        bytesTotal: 129_967_797,
        installedBytes: 129_967_797,
      },
    });
    useSpeechModelStore.getState().setStatus(host.getModelStatus());

    const player = createMockSpeechPlayer();
    const callOrder: string[] = [];
    const origEnqueue = player.enqueue.bind(player);
    const origSetVoice = player.setVoice.bind(player);
    player.enqueue = (items, opts) => {
      if (opts?.replaceFromId) {
        callOrder.push(`enqueue:replaceFrom=${opts.replaceFromId}:count=${items.length}:hasPhonemes=${Boolean(items[0]?.phonemeIds?.length)}`);
      }
      origEnqueue(items, opts);
    };
    player.setVoice = (v) => {
      callOrder.push(`setVoice:${v.kind}:${v.voiceId}`);
      origSetVoice(v);
    };

    const ctl = new ReadAloudController({
      host,
      player,
      getSettings: () => ({
        ...DEFAULT_APP_SETTINGS,
        preferredVoices: {
          en: { kind: 'kokoro', voiceId: 'af_maple' },
        },
      }),
      getIsEink: () => false,
    });

    // resolvePreferredVoice honours kokoro when ready & installed, and falls back to system if not installed
    expect(ctl.resolvePreferredVoice('en')).toEqual({ kind: 'kokoro', voiceId: 'af_maple' });
    expect(ctl.resolvePreferredVoice('zh')).toEqual({ kind: 'system', voiceId: null });

    await ctl.start({
      bookId: 'b_dickens',
      startLocator: { section: 0, offset: 0 },
    });

    // Initial queue has phonemeIds & phonemeSpans attached!
    const firstQueued = player.getQueue()[0]!;
    expect(firstQueued.phonemeIds?.length).toBeGreaterThan(0);
    expect(firstQueued.phonemeSpans?.length).toBeGreaterThan(0);

    // Mid-session switch to another kokoro voice ('zf_001'):
    // 1. Pauses old voice immediately, annotates firstBatch (`idx .. idx + 6`),
    // 2. Calls `player.setVoice` FIRST (purging stale `attachedAudio`),
    // 3. Calls `player.enqueue(fullSlice, { replaceFromId })` so queue is NEVER truncated to 4 items,
    // 4. Resumes `player.play()` immediately!
    const fullQueueLenBefore = player.getQueue().length;
    expect(fullQueueLenBefore).toBeGreaterThanOrEqual(25);
    callOrder.length = 0;
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zf_001' });

    await vi.waitFor(() => {
      expect(callOrder.length).toBeGreaterThanOrEqual(2);
    });
    expect(callOrder[0]).toBe('setVoice:kokoro:zf_001');
    expect(callOrder[1]).toMatch(
      new RegExp(`^enqueue:replaceFrom=.*:count=${fullQueueLenBefore}:hasPhonemes=true$`),
    );
    expect(player.getQueue().length).toBe(fullQueueLenBefore);

    ctl.dispose();
  }, 15_000);

  it('[v0.2.4] live-switches System <-> Kokoro voices mid-Reader (playing, paused & rapid 4-way taps), purges stale attached audio, and bypasses Capacitor custom-scheme Worker timeout', async () => {
    // 1. Verify KokoroG2PClient immediately selects main-thread mode on Capacitor (`window.Capacitor.isNativePlatform()`) with 0 Worker spawns!
    const winWithCap = window as Window & {
      Capacitor?: { isNativePlatform?: () => boolean };
    };
    const prevCap = winWithCap.Capacitor;
    const origUserAgent = navigator.userAgent;
    let workerSpawnCount = 0;
    const origWorker = globalThis.Worker;
    (globalThis as { Worker?: unknown }).Worker = class {
      constructor() {
        workerSpawnCount += 1;
      }
    };
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });
    winWithCap.Capacitor = { isNativePlatform: () => true };
    try {
      const capG2p = new KokoroG2PClient({ handshakeTimeoutMs: 5000 });
      const t0 = performance.now();
      const out = await capG2p.phonemize('你好，世界。', 'zh-CN', { voiceId: 'zf_018' });
      expect(capG2p.getExecutionMode()).toBe('main');
      expect(workerSpawnCount).toBe(0);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(out.phonemeIds.length).toBeGreaterThan(0);
      capG2p.dispose();
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: origUserAgent,
        configurable: true,
      });
      if (prevCap === undefined) delete winWithCap.Capacitor;
      else winWithCap.Capacitor = prevCap;
      (globalThis as { Worker?: unknown }).Worker = origWorker;
    }

    // 2. Verify WebSpeechPlayer.setVoice purges stale `attached` WAVs so switching zf_001 -> zm_010 NEVER replays zf_001!
    const origMediaPlay = HTMLMediaElement.prototype.play;
    const origMediaPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    try {
      const webPlayer = new WebSpeechPlayer({ bufferingTimeoutOnlineMs: 500 });
      await webPlayer.load({
        bookId: 'b_luxun',
        title: '呐喊',
        author: '鲁迅',
        chapterTitle: '故乡',
        voice: { kind: 'kokoro', voiceId: 'zf_001' },
        systemFallback: { kind: 'system', voiceId: null },
        rate: 1.0,
      });
      webPlayer.enqueue([
        {
          id: '0:0-6',
          section: 0,
          start: 0,
          end: 6,
          blockIndex: 0,
          text: '我冒了严寒，',
          lang: 'zh-CN',
          pauseAfterMs: 200,
          phonemeIds: [[73, 127, 172, 4]],
        },
      ]);
      webPlayer.attachAudio('0:0-6', { ref: 'blob:stale-zf001', durationMs: 900 });
      webPlayer.play();
      expect((await webPlayer.getState()).status).toBe('playing');

      // Switch zf_001 -> zm_010: stale `blob:stale-zf001` MUST be purged -> enters `buffering` waiting for zm_010 WAV!
      webPlayer.setVoice({ kind: 'kokoro', voiceId: 'zm_010' });
      expect((await webPlayer.getState()).status).toBe('buffering');
      webPlayer.stop();
    } finally {
      HTMLMediaElement.prototype.play = origMediaPlay;
      HTMLMediaElement.prototype.pause = origMediaPause;
    }

    // 3. End-to-end ReadAloudController: live playing switch, paused switch, and rapid 4-way switch (`zf_001 -> zm_010 -> System -> zf_018`)!
    const host = createMockPlatformHost({
      platform: 'ios',
      initialModelStatus: {
        state: 'ready',
        installedVoices: ['zf_001', 'zm_010', 'zf_018', 'af_maple'],
      },
    });
    useSpeechModelStore.getState().setStatus(host.getModelStatus());
    const player = createMockSpeechPlayer();

    const g2p = new KokoroG2PClient();

    const ctl = new ReadAloudController({
      host,
      player,
      getSettings: () => DEFAULT_APP_SETTINGS,
      getIsEink: () => false,
      g2pClient: g2p,
    });

    await ctl.start({
      bookId: 'b_luxun',
      startLocator: { section: 0, offset: 0 },
    });
    expect(useReadAloudStore.getState().voice).toEqual({ kind: 'system', voiceId: null });
    expect(useReadAloudStore.getState().status).toBe('playing');

    // Advance 1 sentence mid-Reader, then rapidly tap `zf_001 -> zm_010 -> System -> zf_018`!
    player.advanceToNextUtterance();
    const activeMidId = useReadAloudStore.getState().activeUtterance!.id;

    ctl.setVoice({ kind: 'kokoro', voiceId: 'zf_001' });
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zm_010' });
    ctl.setVoice({ kind: 'system', voiceId: null });
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zf_018' });

    await vi.waitFor(() => {
      expect((player.currentUtterance()?.phonemeIds?.length ?? 0) > 0).toBe(true);
      expect(useReadAloudStore.getState().voice).toEqual({ kind: 'kokoro', voiceId: 'zf_018' });
    });
    const playerStateAfterRapid = await player.getState();
    expect(playerStateAfterRapid.voice).toEqual({ kind: 'kokoro', voiceId: 'zf_018' });
    // Player auto-resumed (`buffering` on native/mock waiting for WAV attachment, NOT stuck `paused`!)
    expect(playerStateAfterRapid.status).toBe('buffering');
    expect(player.currentUtterance()?.id).toBe(activeMidId);
    // b_luxun fixture has 6 total sentences -> 5 remaining from sentence #1 (not truncated to 4!)
    expect(player.getQueue().length).toBe(5);

    // Simulate native KokoroSynthQueue attaching WAV for `activeMidId` -> transitions to `playing`!
    player.attachAudio(activeMidId, { ref: 'file:///zf_018.wav', durationMs: 1200 });
    expect(useReadAloudStore.getState().status).toBe('playing');

    // Now test Case 3: Pause playback -> switch `zf_018 -> System -> zm_010` while paused -> stays `paused`, then `togglePlayPause()` plays `zm_010`!
    ctl.togglePlayPause();
    expect(useReadAloudStore.getState().status).toBe('paused');
    ctl.setVoice({ kind: 'system', voiceId: null });
    expect(useReadAloudStore.getState().status).toBe('paused');
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zm_010' });

    await vi.waitFor(async () => {
      expect((await player.getState()).voice).toEqual({ kind: 'kokoro', voiceId: 'zm_010' });
    });
    expect(useReadAloudStore.getState().status).toBe('paused');

    // Press Play -> starts buffering/playing `zm_010` immediately!
    ctl.togglePlayPause();
    expect((await player.getState()).status).toBe('buffering');
    player.attachAudio(activeMidId, { ref: 'file:///zm_010.wav', durationMs: 1100 });
    expect(useReadAloudStore.getState().status).toBe('playing');

    ctl.dispose();
    g2p.dispose();
  }, 15_000);

  it('[v0.2.4] handles async native SpeechPlayer events on Kokoro->System switch (P2-1) and Pause->Play during in-flight Kokoro G2P without leaking old voice (P2-2)', async () => {
    const host = createMockPlatformHost({
      platform: 'ios',
      initialModelStatus: {
        state: 'ready',
        installedVoices: ['zf_001', 'zm_010', 'zf_018'],
      },
    });
    useSpeechModelStore.getState().setStatus(host.getModelStatus());

    // Wrap MockSpeechPlayer so all native speech events arrive asynchronously via setTimeout(5ms),
    // matching real Capacitor bridge timing on iOS/Android, and record every `play()` call's active voice.
    const rawPlayer = createMockSpeechPlayer();
    const origSubscribe = rawPlayer.subscribe.bind(rawPlayer);
    rawPlayer.subscribe = (listener) =>
      origSubscribe((ev) => {
        setTimeout(() => listener(ev), 5);
      });

    const playVoiceLog: Array<string> = [];
    const origPlay = rawPlayer.play.bind(rawPlayer);
    rawPlayer.play = () => {
      void rawPlayer.getState().then((st) => {
        playVoiceLog.push(`${st.voice?.kind ?? 'null'}:${st.voice?.voiceId ?? 'null'}`);
      });
      origPlay();
    };

    // Wrap G2P with a deterministic 25ms async window so rapid taps land mid-G2P
    const realG2p = new KokoroG2PClient();
    const origPhonemize = realG2p.phonemize.bind(realG2p);
    let g2pDelayMs = 25;
    realG2p.phonemize = async (text, lang, opts) => {
      if (g2pDelayMs > 0) {
        await new Promise((r) => setTimeout(r, g2pDelayMs));
      }
      return origPhonemize(text, lang, opts);
    };

    const ctl = new ReadAloudController({
      host,
      player: rawPlayer,
      getSettings: () => DEFAULT_APP_SETTINGS,
      getIsEink: () => false,
      g2pClient: realG2p,
    });

    await ctl.start({
      bookId: 'b_luxun',
      startLocator: { section: 0, offset: 0 },
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(useReadAloudStore.getState().status).toBe('playing');

    // [P2-1]: Switch to zf_001 first, let it settle & attach WAV -> playing zf_001
    g2pDelayMs = 0;
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zf_001' });
    await vi.waitFor(async () => {
      expect((await rawPlayer.getState()).voice).toEqual({ kind: 'kokoro', voiceId: 'zf_001' });
    });
    const curId = rawPlayer.currentUtterance()!.id;
    rawPlayer.attachAudio(curId, { ref: 'file:///zf_001.wav', durationMs: 1000 });
    await new Promise((r) => setTimeout(r, 15));
    expect(useReadAloudStore.getState().status).toBe('playing');

    // Now re-enable 25ms G2P delay and tap `zm_010 -> System` within the G2P window!
    g2pDelayMs = 25;
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zm_010' });
    ctl.setVoice({ kind: 'system', voiceId: null });
    await new Promise((r) => setTimeout(r, 45));

    // Must NOT be left paused when async native events settle!
    expect((await rawPlayer.getState()).voice).toEqual({ kind: 'system', voiceId: null });
    expect((await rawPlayer.getState()).status).toBe('playing');
    expect(useReadAloudStore.getState().status).toBe('playing');

    // [P2-2]: Start switching `System -> zf_018` (25ms G2P window), then tap Pause -> Play mid-switch!
    playVoiceLog.length = 0;
    ctl.setVoice({ kind: 'kokoro', voiceId: 'zf_018' });
    // Pause then Play BEFORE the 25ms G2P completes:
    ctl.togglePlayPause();
    expect(useReadAloudStore.getState().status).toBe('paused');
    ctl.togglePlayPause();
    expect(useReadAloudStore.getState().status).toBe('buffering');
    // Crucial: `rawPlayer.play()` MUST NOT have been called yet while player voice is still `system`!
    expect(playVoiceLog).toEqual([]);
    expect((await rawPlayer.getState()).status).toBe('paused');

    // Once the 25ms G2P completes, `setVoice` switches player to `zf_018`, enqueues, and calls `play()`!
    await vi.waitFor(async () => {
      expect((await rawPlayer.getState()).voice).toEqual({ kind: 'kokoro', voiceId: 'zf_018' });
      expect((await rawPlayer.getState()).status).toBe('buffering');
    });
    expect(playVoiceLog).toEqual(['kokoro:zf_018']);

    ctl.dispose();
    realG2p.dispose();
  }, 15_000);
});
