import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '@minibook/core';
import {
  AutoPageTurn,
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
});
