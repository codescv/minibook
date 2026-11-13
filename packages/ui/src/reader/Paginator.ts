import type { Locator, MarginPreset, ReadingDirection, SectionDoc } from '@minibook/core';
import type { TextMap } from './TextMap';

export interface PaginationGeometryInput {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly fontScale: number;
  readonly margins: MarginPreset;
  readonly safeTop: number;
  readonly safeBottom: number;
  readonly isEink: boolean;
  readonly isCoverLike?: boolean;
}

export interface PaginationGeometry {
  /** Floored viewport width: exact integer multiple of `2 * n`. */
  readonly Vw: number;
  readonly Vh: number;
  /** Columns per screen (`1`, or `2` when `frameWidth >= 1100` in landscape). */
  readonly n: 1 | 2;
  /** Column stride `P = Vw / n` (even integer). */
  readonly P: number;
  /** Column text measure `Cw <= round(34 * fontSizePx)`. */
  readonly Cw: number;
  /** Column gap `G = P - Cw` (even integer, `>= gMin`; `n * (Cw + G) === Vw`). */
  readonly G: number;
  /** Maximum measure `round(34 * fontSizePx)`. */
  readonly M: number;
  readonly fontSizePx: number;
  /** Constant top padding `48 + safeTop` (never changes when Chrome toggles). */
  readonly pt: number;
  /** Constant bottom padding `64 + safeBottom` (never changes when Chrome/ReadAloudBar toggles). */
  readonly pb: number;
  readonly contentHeight: number;
}

const BASE_SIDE_MARGIN: Record<MarginPreset, number> = {
  narrow: 24,
  medium: 32,
  wide: 48,
};

/**
 * Computes exact integer multicol geometry (`ARCHITECTURE.md` §6.3 & `UI_SPEC.md` §3.3).
 * Guarantees:
 *   1. `Cw <= round(34 * fontSizePx)` (whenever `P > gMin`)
 *   2. `G` is an even integer (`G/2` is an exact integer)
 *   3. `n * (Cw + G) === Vw`
 *   4. `pt = 48 + safeTop`, `pb = 64 + safeBottom` (constant across bare / chrome / TTS)
 */
export function computePaginationGeometry(input: PaginationGeometryInput): PaginationGeometry {
  const rawW = Math.max(120, Math.floor(input.frameWidth));
  const Vh = Math.max(180, Math.floor(input.frameHeight));

  const n: 1 | 2 =
    !input.isCoverLike && rawW >= 1100 && rawW > Vh ? 2 : 1;

  const Vw = Math.max(2 * n, Math.floor(rawW / (2 * n)) * (2 * n));
  const P = Vw / n;

  const baseFontPx = rawW >= 840 ? 19 : 18;
  const effectiveScale = input.isEink ? Math.max(100, input.fontScale) : input.fontScale;
  const fontSizePx = Math.round(((baseFontPx * effectiveScale) / 100) * 100) / 100;
  const M = Math.round(34 * fontSizePx);

  const baseMargin = BASE_SIDE_MARGIN[input.margins];
  const m = rawW >= 840 ? Math.round(baseMargin * 1.5) : baseMargin;
  const gMin = n === 2 ? Math.max(2 * m, 64) : 2 * m;

  let Cw = Math.min(P - gMin, M);
  if (Cw < 40) {
    Cw = Math.max(2, P - Math.min(P - 2, 32));
  }
  if ((P - Cw) % 2 !== 0) {
    Cw -= 1;
  }
  const G = P - Cw;

  const pt = Math.round(48 + Math.max(0, input.safeTop));
  const pb = Math.round(64 + Math.max(0, input.safeBottom));
  const contentHeight = Math.max(60, Vh - pt - pb);

  return {
    Vw,
    Vh,
    n,
    P,
    Cw,
    G,
    M,
    fontSizePx,
    pt,
    pb,
    contentHeight,
  };
}

let cachedRtlNegativeScroll: boolean | null = null;

function usesNegativeRtlScroll(doc: Document): boolean {
  if (cachedRtlNegativeScroll !== null) return cachedRtlNegativeScroll;
  try {
    const probe = doc.createElement('div');
    probe.dir = 'rtl';
    probe.style.cssText =
      'position:fixed;top:-9999px;width:10px;height:10px;overflow:scroll;direction:rtl;';
    const inner = doc.createElement('div');
    inner.style.cssText = 'width:30px;height:10px;';
    probe.appendChild(inner);
    doc.body.appendChild(probe);
    probe.scrollLeft = -5;
    cachedRtlNegativeScroll = probe.scrollLeft < 0;
    probe.remove();
  } catch {
    cachedRtlNegativeScroll = true;
  }
  return cachedRtlNegativeScroll;
}

export class Paginator {
  private readonly frameDoc: Document;
  private readonly textMap: TextMap;
  private readonly sectionDoc: SectionDoc;
  private geom: PaginationGeometry;
  private dir: ReadingDirection;
  private columnCount = 1;
  private screenCount = 1;
  private currentPage = 0;
  private tweenRaf: number | null = null;

  constructor(options: {
    readonly frameDoc: Document;
    readonly textMap: TextMap;
    readonly sectionDoc: SectionDoc;
    readonly geometry: PaginationGeometry;
  }) {
    this.frameDoc = options.frameDoc;
    this.textMap = options.textMap;
    this.sectionDoc = options.sectionDoc;
    this.geom = options.geometry;
    this.dir = options.sectionDoc.dir;
    this.ensureSentinel();
    this.scaleOversizedBlocks();
    this.measure();
  }

  getGeometry(): PaginationGeometry {
    return this.geom;
  }

  getPageCount(): number {
    return this.screenCount;
  }

  getColumnCount(): number {
    return this.columnCount;
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  updateGeometry(next: PaginationGeometry): void {
    if (this.tweenRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.tweenRaf);
      this.tweenRaf = null;
    }
    this.geom = next;
    this.ensureSentinel();
    this.scaleOversizedBlocks();
    this.measure();
  }

  private ensureSentinel(): HTMLElement {
    let el = this.frameDoc.getElementById('mb-end');
    if (!el) {
      el = this.frameDoc.createElement('span');
      el.id = 'mb-end';
      el.setAttribute('data-mb-skip', '');
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'display:inline-block;width:0px;height:1px;padding:0;margin:0;vertical-align:baseline;';
      this.frameDoc.body.appendChild(el);
    } else if (el !== this.frameDoc.body.lastElementChild) {
      this.frameDoc.body.appendChild(el);
    }
    return el;
  }

  /**
   * Ensures `html.scrollWidth >= S * Vw` even when trailing end padding (`G/2`) or an empty
   * trailing spread column (`n = 2`, odd `K`) would otherwise cause `scrollLeft` to clamp short
   * of `(S - 1) * Vw` on the last page of a render unit.
   */
  private syncScrollExtentSpacer(screenCount: number): void {
    let spacer = this.frameDoc.getElementById('mb-scroll-spacer');
    if (!spacer) {
      spacer = this.frameDoc.createElement('div');
      spacer.id = 'mb-scroll-spacer';
      spacer.setAttribute('data-mb-skip', '');
      spacer.setAttribute('aria-hidden', 'true');
      this.frameDoc.documentElement.appendChild(spacer);
    }
    const totalPx = Math.max(1, screenCount * this.geom.Vw);
    if (this.dir === 'rtl' && usesNegativeRtlScroll(this.frameDoc)) {
      spacer.style.cssText = `position:absolute;top:0;right:${totalPx - 1}px;width:1px;height:1px;pointer-events:none;`;
    } else {
      spacer.style.cssText = `position:absolute;top:0;left:${totalPx - 1}px;width:1px;height:1px;pointer-events:none;`;
    }
  }

  private scaleOversizedBlocks(): void {
    const maxW = this.geom.Cw;
    if (maxW <= 0) return;
    const candidates = this.frameDoc.body.querySelectorAll('table, pre, figure');
    for (const node of candidates) {
      const el = node as HTMLElement;
      const w = el.scrollWidth;
      if (w > maxW + 2) {
        const ratio = maxW / w;
        el.style.transformOrigin = this.dir === 'rtl' ? 'top right' : 'top left';
        el.style.transform = `scale(${ratio.toFixed(4)})`;
      }
    }
  }

  /**
   * Measures total columns `K` and screens `S = ceil(K / n)` using `#mb-end` sentinel
   * (`ARCHITECTURE.md` §6.3 — never relies on `scrollWidth` padding ambiguities).
   */
  measure(): { columnCount: number; pageCount: number } {
    if (this.sectionDoc.isCoverLike) {
      this.columnCount = 1;
      this.screenCount = 1;
      this.currentPage = 0;
      this.syncScrollExtentSpacer(1);
      return { columnCount: 1, pageCount: 1 };
    }

    const sentinel = this.ensureSentinel();
    const rect = sentinel.getBoundingClientRect();
    const html = this.frameDoc.documentElement;
    const { P, G, Vw, n } = this.geom;

    if (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.right === 0) {
      this.columnCount = 1;
      this.screenCount = 1;
      this.syncScrollExtentSpacer(1);
      return { columnCount: 1, pageCount: 1 };
    }

    let K: number;
    if (this.dir === 'rtl') {
      const scrollMag = Math.abs(html.scrollLeft);
      const distFromRight = Vw - rect.right + scrollMag;
      K = Math.max(1, Math.floor((distFromRight - G / 2 + 1) / P) + 1);
    } else {
      const docLeft = rect.left + html.scrollLeft;
      K = Math.max(1, Math.floor((docLeft - G / 2 + 1) / P) + 1);
    }

    const S = Math.max(1, Math.ceil(K / n));
    this.columnCount = K;
    this.screenCount = S;
    this.syncScrollExtentSpacer(S);
    if (this.currentPage >= S) {
      this.currentPage = S - 1;
    }
    return { columnCount: K, pageCount: S };
  }

  private targetScrollLeftForPage(page: number): number {
    const s = Math.max(0, Math.min(this.screenCount - 1, page));
    if (this.dir === 'rtl') {
      return usesNegativeRtlScroll(this.frameDoc) ? -s * this.geom.Vw : s * this.geom.Vw;
    }
    return s * this.geom.Vw;
  }

  /**
   * Applies a live 1:1 horizontal pointer drag offset (`dx` in screen px, `< 0` when dragging left,
   * `> 0` when dragging right) relative to `currentPage`, revealing the adjacent page content
   * continuously from the viewport edge in normal mode (`!isEink`).
   */
  setDragOffset(dx: number): void {
    if (this.tweenRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.tweenRaf);
      this.tweenRaf = null;
    }
    const html = this.frameDoc.documentElement;
    const maxMag = Math.max(0, (this.screenCount - 1) * this.geom.Vw);
    const base = this.targetScrollLeftForPage(this.currentPage);

    if (this.dir === 'rtl') {
      if (usesNegativeRtlScroll(this.frameDoc)) {
        const next = Math.max(-maxMag, Math.min(0, Math.round(base - dx)));
        html.scrollLeft = next;
      } else {
        const next = Math.max(0, Math.min(maxMag, Math.round(base + dx)));
        html.scrollLeft = next;
      }
      return;
    }

    const next = Math.max(0, Math.min(maxMag, Math.round(base - dx)));
    html.scrollLeft = next;
  }

  goToPage(
    page: number,
    options?: { readonly animate?: boolean; readonly isEink?: boolean; readonly durationMs?: number },
  ): number {
    if (this.tweenRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.tweenRaf);
      this.tweenRaf = null;
    }

    const targetPage = Math.max(0, Math.min(this.screenCount - 1, page));
    this.currentPage = targetPage;
    const html = this.frameDoc.documentElement;
    const targetScroll = this.targetScrollLeftForPage(targetPage);

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const shouldAnimate =
      Boolean(options?.animate) &&
      !options?.isEink &&
      !reducedMotion &&
      typeof requestAnimationFrame === 'function' &&
      Math.abs(html.scrollLeft - targetScroll) > 1;

    if (!shouldAnimate) {
      html.scrollLeft = targetScroll;
      return targetPage;
    }

    const startScroll = html.scrollLeft;
    const delta = targetScroll - startScroll;
    const durationMs = options?.durationMs ?? 250;
    const t0 = performance.now();

    const tick = (now: number): void => {
      const elapsed = now - t0;
      if (elapsed >= durationMs) {
        html.scrollLeft = targetScroll;
        this.tweenRaf = null;
        return;
      }
      const p = elapsed / durationMs;
      const eased = 1 - Math.pow(1 - p, 3);
      html.scrollLeft = Math.round(startScroll + delta * eased);
      this.tweenRaf = requestAnimationFrame(tick);
    };

    this.tweenRaf = requestAnimationFrame(tick);
    return targetPage;
  }

  /**
   * Finds the first non-empty client rect for `localOffset` (`ARCHITECTURE.md` §6.5):
   * probes forward up to 64 chars, then backward up to 64 chars, and falls back to
   * the containing element's bounding rect so collapsed whitespace never throws or returns undefined.
   */
  rectAt(localOffset: number): DOMRect | null {
    const len = this.textMap.length;
    if (len === 0) {
      return this.frameDoc.body.getBoundingClientRect();
    }
    const base = Math.max(0, Math.min(len - 1, localOffset));

    const tryAt = (idx: number, requirePositiveWidth: boolean): DOMRect | null => {
      const r = this.textMap.charRangeAt(idx);
      if (!r) return null;
      const rects = r.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i]!;
        if (requirePositiveWidth ? rect.width > 0 : rect.width > 0 || rect.height > 0) {
          return rect;
        }
      }
      return null;
    };

    const maxForward = Math.min(len - 1, base + 64);
    for (let i = base; i <= maxForward; i++) {
      const hit = tryAt(i, true);
      if (hit) return hit;
    }

    const minBackward = Math.max(0, base - 64);
    for (let i = base - 1; i >= minBackward; i--) {
      const hit = tryAt(i, true);
      if (hit) return hit;
    }

    const zeroWidthHit = tryAt(base, false);
    if (zeroWidthHit) return zeroWidthHit;

    const located = this.textMap.locateOffset(base);
    const parentEl = located?.node.parentElement ?? this.frameDoc.body;
    return parentEl.getBoundingClientRect();
  }

  pageOf(sectionOffset: number): number {
    if (this.screenCount <= 1 || this.textMap.length === 0) return 0;
    const local = Math.max(
      0,
      Math.min(this.textMap.length - 1, sectionOffset - this.sectionDoc.unit.start),
    );
    const rect = this.rectAt(local);
    if (!rect) return 0;

    const html = this.frameDoc.documentElement;
    const { P, G, Vw, n } = this.geom;

    let column: number;
    if (this.dir === 'rtl') {
      const scrollMag = Math.abs(html.scrollLeft);
      const distFromRight = Vw - rect.right + scrollMag;
      column = Math.floor((distFromRight - G / 2 + 0.5) / P);
    } else {
      const docLeft = rect.left + html.scrollLeft;
      column = Math.floor((docLeft - G / 2 + 0.5) / P);
    }

    const page = Math.floor(Math.max(0, column) / n);
    return Math.max(0, Math.min(this.screenCount - 1, page));
  }

  private pointHitsLocalOffset(x: number, y: number, localOffset: number): boolean {
    if (this.textMap.length === 0) return false;
    const candidates = [
      Math.max(0, Math.min(this.textMap.length - 1, localOffset)),
      Math.max(0, Math.min(this.textMap.length - 1, localOffset - 1)),
    ];
    for (const idx of candidates) {
      const r = this.textMap.charRangeAt(idx);
      if (!r) continue;
      const rects = r.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const rect = rects[i]!;
        if (rect.width <= 0 && rect.height <= 0) continue;
        if (
          x >= rect.left - 8 &&
          x <= rect.right + 8 &&
          y >= rect.top - 6 &&
          y <= rect.bottom + 6
        ) {
          return true;
        }
      }
    }
    return false;
  }

  locatorAtPoint(
    x: number,
    y: number,
    options?: { readonly strictHitRect?: boolean },
  ): Locator | null {
    const doc = this.frameDoc as Document & {
      caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (px: number, py: number) => Range | null;
    };

    if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) {
        const local = this.textMap.offsetFromPointOrRangeNode(pos.offsetNode, pos.offset);
        if (local !== null) {
          if (options?.strictHitRect && !this.pointHitsLocalOffset(x, y, local)) {
            return null;
          }
          return { section: this.sectionDoc.index, offset: this.sectionDoc.unit.start + local };
        }
      }
    }

    if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) {
        const local = this.textMap.offsetFromPointOrRangeNode(
          range.startContainer,
          range.startOffset,
        );
        if (local !== null) {
          if (options?.strictHitRect && !this.pointHitsLocalOffset(x, y, local)) {
            return null;
          }
          return { section: this.sectionDoc.index, offset: this.sectionDoc.unit.start + local };
        }
      }
    }

    return null;
  }

  locatorFromRange(range: Range): Locator | null {
    const local = this.textMap.offsetFromPointOrRangeNode(range.startContainer, range.startOffset);
    if (local === null) return null;
    return {
      section: this.sectionDoc.index,
      offset: this.sectionDoc.unit.start + local,
    };
  }

  firstVisibleLocator(page = this.currentPage): Locator {
    if (this.textMap.length === 0) {
      return { section: this.sectionDoc.index, offset: this.sectionDoc.unit.start };
    }

    // Binary search over TextMap for the smallest local offset whose `pageOf` >= `page`
    let lo = 0;
    let hi = this.textMap.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.pageOf(this.sectionDoc.unit.start + mid);
      if (p >= page) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    return {
      section: this.sectionDoc.index,
      offset: this.sectionDoc.unit.start + ans,
    };
  }

  /**
   * Counts how many characters of `[start, end)` fall on `firstPage` (for `AutoPageTurn` straddling math).
   */
  countCharsOnPage(sectionStart: number, sectionEnd: number, targetPage: number): number {
    const s = Math.max(this.sectionDoc.unit.start, sectionStart);
    const e = Math.min(this.sectionDoc.unit.end, sectionEnd);
    if (e <= s) return 0;

    let lo = s;
    let hi = e - 1;
    let lastOnPage = s;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.pageOf(mid) <= targetPage) {
        lastOnPage = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return Math.max(1, lastOnPage - s + 1);
  }

  destroy(): void {
    if (this.tweenRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.tweenRaf);
      this.tweenRaf = null;
    }
  }
}
