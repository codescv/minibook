import { describe, expect, it, vi } from 'vitest';
import {
  AutoPageTurn,
  computePaginationGeometry,
  Highlighter,
  mergeLineRects,
  TextMap,
} from '../index';
import { DEFAULT_APP_SETTINGS, FONT_SCALE_STEPS } from '@minibook/core';

describe('Integer Multicol Pagination Math (ARCHITECTURE.md §6.3)', () => {
  it('holds Cw <= 34em, G even, and n*(Cw+G) === Vw across widths 320..2560px', () => {
    const margins = ['narrow', 'medium', 'wide'] as const;
    for (let width = 320; width <= 2560; width += 29) {
      for (const height of [680, 900]) {
        for (const margin of margins) {
          for (const scale of [FONT_SCALE_STEPS[0], 100, 150, FONT_SCALE_STEPS[11]]) {
            for (const isEink of [false, true]) {
              const g = computePaginationGeometry({
                frameWidth: width,
                frameHeight: height,
                fontScale: scale,
                margins: margin,
                safeTop: 59,
                safeBottom: 34,
                isEink,
              });

              expect(g.G % 2).toBe(0);
              expect(g.n * (g.Cw + g.G)).toBe(g.Vw);
              expect(g.Cw).toBeLessThanOrEqual(g.M);
              expect(g.pt).toBe(48 + 59);
              expect(g.pb).toBe(64 + 34);

              if (width >= 1100 && width > height) {
                expect(g.n).toBe(2);
                expect(g.G).toBeGreaterThanOrEqual(64);
              } else {
                expect(g.n).toBe(1);
              }

              if (isEink && scale < 100) {
                const base = width >= 840 ? 19 : 18;
                expect(g.fontSizePx).toBe(base);
              }
            }
          }
        }
      }
    }
  });

  it('reproduces exact canonical spec dimensions on 393px phone, 1050px desktop, and 1440px spread', () => {
    const phone = computePaginationGeometry({
      frameWidth: 393,
      frameHeight: 852,
      fontScale: 100,
      margins: 'medium',
      safeTop: 59,
      safeBottom: 34,
      isEink: false,
    });
    expect(phone.Vw).toBe(392);
    expect(phone.n).toBe(1);
    expect(phone.Cw).toBe(328);
    expect(phone.G).toBe(64);

    const desktop1Col = computePaginationGeometry({
      frameWidth: 1050,
      frameHeight: 820,
      fontScale: 100,
      margins: 'medium',
      safeTop: 0,
      safeBottom: 0,
      isEink: false,
    });
    expect(desktop1Col.n).toBe(1);
    expect(desktop1Col.M).toBe(646);
    expect(desktop1Col.Cw).toBe(646);
    expect(desktop1Col.G).toBe(404);

    const spread = computePaginationGeometry({
      frameWidth: 1440,
      frameHeight: 900,
      fontScale: 100,
      margins: 'medium',
      safeTop: 0,
      safeBottom: 0,
      isEink: false,
    });
    expect(spread.n).toBe(2);
    expect(spread.P).toBe(720);
    expect(spread.Cw).toBe(624);
    expect(spread.G).toBe(96);
    expect(spread.n * (spread.Cw + spread.G)).toBe(1440);
  });
});

describe('TextMap I-TEXT Invariant & Skipped Subtrees (§5.3)', () => {
  it('skips ruby <rt> and footnote [data-mb-skip] nodes and matches SectionText 1-to-1', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<h2>故乡</h2><p>第一句<sup data-mb-skip="">[1]</sup>。</p><p><ruby>漢字<rt data-mb-skip="">かんじ</rt></ruby>語</p>';

    const expected = '故乡第一句。漢字語';
    const tm = new TextMap(container, expected);

    expect(tm.text).toBe(expected);
    expect(tm.invariantMatched).toBe(true);

    // Range spanning ruby base + following char cleanly bridges skipped <rt>
    const kanjiIdx = expected.indexOf('漢字語');
    const r = tm.rangeFor(kanjiIdx, kanjiIdx + 3);
    expect(r).not.toBeNull();
    expect(r!.toString()).toContain('漢字');

    // Hitting a skipped <rt> node snaps forward to '語'
    const rtText = container.querySelector('rt')!.firstChild!;
    const snapped = tm.offsetFromPointOrRangeNode(rtText, 1);
    expect(snapped).toBe(expected.indexOf('語'));
  });
});

describe('Highlighter Seam-Free Line Rects & E-Ink 2px Underline (§8.7, #13 P2 #3)', () => {
  it('merges inline fragments and clamps vertical adjacency so zero pixels overlap', () => {
    const raw = [
      { left: 32, top: 100.4, right: 140, bottom: 124.7, width: 108, height: 24.3 },
      { left: 140, top: 100.2, right: 320, bottom: 124.8, width: 180, height: 24.6 },
      // Second line slightly overlapping by 1.2px due to font ascent/descent box:
      { left: 32, top: 123.6, right: 290, bottom: 148.2, width: 258, height: 24.6 },
    ];

    const merged = mergeLineRects(raw, 0);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.left).toBe(32);
    expect(merged[0]!.right).toBe(320);
    // Zero vertical overlap seam!
    expect(merged[0]!.bottom).toBeLessThanOrEqual(merged[1]!.top);
  });

  it('draws 2px #000000 underline only in E-Ink mode and never registers word highlight', () => {
    const doc = document.implementation.createHTMLDocument('test');
    doc.body.innerHTML = '<p>Hello quiet world.</p>';
    const tm = new TextMap(doc.body, 'Hello quiet world.');
    const sectionDoc = {
      index: 0,
      unit: { start: 0, end: 18 },
      xhtml: '<p>Hello quiet world.</p>',
      css: '',
      lang: 'en',
      dir: 'ltr' as const,
      text: { text: 'Hello quiet world.', blocks: [{ start: 0, end: 18, kind: 'p' as const, lang: 'en' }] },
      resources: [],
    };

    // Stub Range.prototype.getClientRects in jsdom for this document
    const textRangeProto = Object.getPrototypeOf(doc.createRange()) as Range;
    const origGetRects = textRangeProto.getClientRects;
    textRangeProto.getClientRects = () =>
      ([
        { left: 32, top: 100, right: 180, bottom: 122, width: 148, height: 22, x: 32, y: 100, toJSON: () => ({}) },
      ] as unknown as DOMRectList);

    try {
      const hl = new Highlighter({
        frameDoc: doc,
        textMap: tm,
        sectionDoc,
        forceOverlayFallback: true,
      });

      hl.paintSpeech({
        sentence: { start: 0, end: 18 },
        word: { start: 6, end: 11 },
        settings: DEFAULT_APP_SETTINGS,
        isEink: true,
      });

      const lines = doc.querySelectorAll('.mb-hl-overlay-eink-line');
      expect(lines).toHaveLength(1);
      expect((lines[0] as HTMLElement).style.height).toBe('2px');
      expect((lines[0] as HTMLElement).style.backgroundColor).toBe('rgb(0, 0, 0)');
      expect(doc.querySelectorAll('.mb-hl-overlay-box')).toHaveLength(0);
    } finally {
      textRangeProto.getClientRects = origGetRects;
    }
  });
});

describe('AutoPageTurn Straddling Sentence Logic (§8.7)', () => {
  it('turns proportionally across a page break when no word event arrives, or immediately on word boundary', () => {
    vi.useFakeTimers();
    try {
      const apt = new AutoPageTurn();
      let page = 0;
      const adapter = {
        visibleSection: 0,
        currentPage: () => page,
        pageOf: (off: number) => (off < 40 ? 0 : 1),
        countCharsOnPage: () => 40,
        goToPage: (p: number) => {
          page = p;
        },
        jumpToLocator: () => {},
      };

      const straddling = {
        id: '0:0-100',
        section: 0,
        start: 0,
        end: 100,
        blockIndex: 0,
        text: 'a'.repeat(100),
        lang: 'en',
        pauseAfterMs: 200,
      };

      // Attached duration 2000ms at 1.0x, 40/100 chars on page 0 -> turns at 800ms
      apt.onUtteranceStart(straddling, adapter, { rate: 1.0, attachedDurationMs: 2000, now: 1000 });
      expect(page).toBe(0);
      vi.advanceTimersByTime(790);
      expect(page).toBe(0);
      vi.advanceTimersByTime(20);
      expect(page).toBe(1);

      // Word boundary crossing page break turns immediately and cancels timer
      page = 0;
      apt.onUtteranceStart(straddling, adapter, { rate: 1.0, attachedDurationMs: 2000, now: 3000 });
      apt.onUtteranceWord(straddling, 45, adapter);
      expect(page).toBe(1);
      apt.reset();
    } finally {
      vi.useRealTimers();
    }
  });
});
