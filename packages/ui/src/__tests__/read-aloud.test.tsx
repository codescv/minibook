import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@minibook/core';
import {
  createMockPlatformHost,
  createMockSpeechPlayer,
  ReadAloudController,
  RefreshController,
  useReadAloudStore,
  WebSpeechPlayer,
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
      vi.advanceTimersByTime(20);
      await Promise.resolve();
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
  });
});
