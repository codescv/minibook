import type { AppSettings, SectionDoc } from '@minibook/core';
import { resolveActiveThemeColors } from '../theme/theme-manager';
import type { TextMap } from './TextMap';

export interface MergedRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Merges raw `Range.getClientRects()` fragments into clean, integer-snapped,
 * strictly non-overlapping line boxes (`prev.bottom <= next.top` within a column)
 * so multi-line sentence tints have **0px overlap seam** (Stage-2 `#13` P2 #3).
 */
export function mergeLineRects(
  rawRects: ArrayLike<Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>>,
  scrollLeft = 0,
): MergedRect[] {
  const valid: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (let i = 0; i < rawRects.length; i++) {
    const r = rawRects[i]!;
    if (r.width < 0.5 || r.height < 0.5) continue;
    valid.push({
      left: r.left + scrollLeft,
      top: r.top,
      right: r.right + scrollLeft,
      bottom: r.bottom,
    });
  }
  if (valid.length === 0) return [];

  // Group into line boxes: rects on the same line share vertical center within 4px and horizontal proximity
  const lines: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  for (const r of valid) {
    const midY = (r.top + r.bottom) / 2;
    const match = lines.find((ln) => {
      const lnMidY = (ln.top + ln.bottom) / 2;
      const sameRow = Math.abs(midY - lnMidY) <= 4;
      const sameColumn = !(r.left > ln.right + 48 || r.right < ln.left - 48);
      return sameRow && sameColumn;
    });
    if (match) {
      match.left = Math.min(match.left, r.left);
      match.top = Math.min(match.top, r.top);
      match.right = Math.max(match.right, r.right);
      match.bottom = Math.max(match.bottom, r.bottom);
    } else {
      lines.push({ ...r });
    }
  }

  // Sort by column X cluster, then top-to-bottom Y
  lines.sort((a, b) => {
    if (Math.abs(a.left - b.left) > 96) return a.left - b.left;
    return a.top - b.top;
  });

  // Snap to integer device-independent pixels & clamp adjacent lines in the same column so `prev.bottom <= next.top`
  const rounded = lines.map((ln) => ({
    left: Math.round(ln.left),
    top: Math.round(ln.top),
    right: Math.round(ln.right),
    bottom: Math.round(ln.bottom),
  }));

  for (let i = 0; i < rounded.length - 1; i++) {
    const cur = rounded[i]!;
    const nxt = rounded[i + 1]!;
    const horizontallyOverlaps = !(cur.right < nxt.left || nxt.right < cur.left);
    if (horizontallyOverlaps && cur.bottom > nxt.top) {
      cur.bottom = nxt.top;
    }
  }

  return rounded
    .filter((ln) => ln.right > ln.left && ln.bottom > ln.top)
    .map((ln) => ({
      left: ln.left,
      top: ln.top,
      right: ln.right,
      bottom: ln.bottom,
      width: ln.right - ln.left,
      height: ln.bottom - ln.top,
    }));
}

interface CustomHighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

type HighlightCtor = new (...ranges: AbstractRange[]) => unknown;

/**
 * Renders Read-Aloud sentence/word highlights and search matches without mutating book text DOM
 * (`ARCHITECTURE.md` §8.7, §9.2):
 * - Normal mode: CSS Custom Highlight API (`::highlight(mb-sentence)` / `::highlight(mb-word)`) when supported,
 *   falling back to non-overlapping merged line-rect overlays (`0px` seam).
 * - E-Ink mode: sentence-only `2px solid #000000` crisp integer underline bars (zero background tint,
 *   `mb-word` never registered).
 * - Maintains independent `speechLayer` and `searchLayer` containers so `paintSpeech` never wipes
 *   search underlines and `paintSearchHit` always clears stale search underlines first.
 */
export class Highlighter {
  private readonly frameDoc: Document;
  private readonly textMap: TextMap;
  private readonly sectionDoc: SectionDoc;
  private readonly forceOverlayFallback: boolean;
  private overlayRoot: HTMLDivElement | null = null;
  private speechLayer: HTMLDivElement | null = null;
  private searchLayer: HTMLDivElement | null = null;

  constructor(options: {
    readonly frameDoc: Document;
    readonly textMap: TextMap;
    readonly sectionDoc: SectionDoc;
    readonly forceOverlayFallback?: boolean;
  }) {
    this.frameDoc = options.frameDoc;
    this.textMap = options.textMap;
    this.sectionDoc = options.sectionDoc;
    this.forceOverlayFallback = options.forceOverlayFallback ?? false;
  }

  private getHighlightApi(): { registry: CustomHighlightRegistry; Highlight: HighlightCtor } | null {
    if (this.forceOverlayFallback) return null;
    const win = this.frameDoc.defaultView as
      | (Window & { CSS?: { highlights?: CustomHighlightRegistry }; Highlight?: HighlightCtor })
      | null;
    if (win?.CSS?.highlights && typeof win.Highlight === 'function') {
      return { registry: win.CSS.highlights, Highlight: win.Highlight };
    }
    return null;
  }

  private ensureLayers(): { speech: HTMLDivElement; search: HTMLDivElement } {
    if (
      this.overlayRoot?.isConnected &&
      this.speechLayer?.isConnected &&
      this.searchLayer?.isConnected
    ) {
      return { speech: this.speechLayer, search: this.searchLayer };
    }
    const root = this.frameDoc.createElement('div');
    root.setAttribute('data-mb-skip', '');
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-testid', 'mb-highlight-overlay');
    root.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:5;';

    const speech = this.frameDoc.createElement('div');
    speech.setAttribute('data-layer', 'speech');
    speech.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;';

    const search = this.frameDoc.createElement('div');
    search.setAttribute('data-layer', 'search');
    search.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;';

    root.appendChild(speech);
    root.appendChild(search);
    this.frameDoc.documentElement.appendChild(root);

    this.overlayRoot = root;
    this.speechLayer = speech;
    this.searchLayer = search;
    return { speech, search };
  }

  private sectionRangeToDomRange(sectionStart: number, sectionEnd: number): Range | null {
    const unitStart = this.sectionDoc.unit.start;
    const unitEnd = this.sectionDoc.unit.end;
    const clampedStart = Math.max(unitStart, sectionStart);
    const clampedEnd = Math.min(unitEnd, sectionEnd);
    if (clampedEnd <= clampedStart) return null;
    return this.textMap.rangeFor(clampedStart - unitStart, clampedEnd - unitStart);
  }

  paintSpeech(options: {
    readonly sentence: { readonly start: number; readonly end: number } | null;
    readonly word: { readonly start: number; readonly end: number } | null;
    readonly settings: AppSettings;
    readonly isEink: boolean;
  }): void {
    const api = this.getHighlightApi();
    const { speech } = this.ensureLayers();
    speech.replaceChildren();

    if (api) {
      api.registry.delete('mb-sentence');
      api.registry.delete('mb-word');
    }

    if (!options.sentence) return;

    const sentenceRange = this.sectionRangeToDomRange(options.sentence.start, options.sentence.end);
    if (!sentenceRange) return;

    const scrollLeft = this.frameDoc.documentElement.scrollLeft;

    if (options.isEink) {
      // E-Ink mode (R4): sentence-level 2px solid #000000 underline ONLY; word highlight never registered
      const rects = mergeLineRects(sentenceRange.getClientRects(), scrollLeft);
      for (const r of rects) {
        const line = this.frameDoc.createElement('div');
        line.className = 'mb-hl-overlay-eink-line';
        line.style.cssText = `position:absolute;left:${r.left}px;top:${r.bottom + 1}px;width:${r.width}px;height:2px;background-color:#000000;pointer-events:none;`;
        speech.appendChild(line);
      }
      return;
    }

    const colors = resolveActiveThemeColors(options.settings, false);
    if (api) {
      api.registry.set('mb-sentence', new api.Highlight(sentenceRange));
      if (options.word) {
        const wordRange = this.sectionRangeToDomRange(options.word.start, options.word.end);
        if (wordRange) {
          api.registry.set('mb-word', new api.Highlight(wordRange));
        }
      }
      return;
    }

    // Fallback: non-overlapping merged line-rect overlay (`0px` seam)
    const sentenceRects = mergeLineRects(sentenceRange.getClientRects(), scrollLeft);
    for (const r of sentenceRects) {
      const box = this.frameDoc.createElement('div');
      box.className = 'mb-hl-overlay-box';
      box.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background-color:${colors.hlSentence};pointer-events:none;`;
      speech.appendChild(box);
    }

    if (options.word) {
      const wordRange = this.sectionRangeToDomRange(options.word.start, options.word.end);
      if (wordRange) {
        const wordRects = mergeLineRects(wordRange.getClientRects(), scrollLeft);
        const strokeColor = colors.hlWord.replace(/^2px\s+solid\s+/i, '');
        for (const r of wordRects) {
          const ul = this.frameDoc.createElement('div');
          ul.className = 'mb-hl-overlay-box';
          ul.style.cssText = `position:absolute;left:${r.left}px;top:${r.bottom}px;width:${r.width}px;height:2px;background-color:${strokeColor};pointer-events:none;`;
          speech.appendChild(ul);
        }
      }
    }
  }

  paintSearchHit(
    hit: { readonly start: number; readonly end: number } | null,
    isEink: boolean,
  ): void {
    const api = this.getHighlightApi();
    const { search } = this.ensureLayers();
    search.replaceChildren();
    if (api) {
      api.registry.delete('mb-search');
    }
    if (!hit) return;
    const range = this.sectionRangeToDomRange(hit.start, hit.end);
    if (!range) return;

    if (isEink) {
      const rects = mergeLineRects(range.getClientRects(), this.frameDoc.documentElement.scrollLeft);
      for (const r of rects) {
        const line = this.frameDoc.createElement('div');
        line.className = 'mb-hl-overlay-eink-line';
        line.style.cssText = `position:absolute;left:${r.left}px;top:${r.bottom + 1}px;width:${r.width}px;height:2px;background-color:#000000;pointer-events:none;`;
        search.appendChild(line);
      }
      return;
    }

    if (api) {
      api.registry.set('mb-search', new api.Highlight(range));
    }
  }

  clearAll(): void {
    const api = this.getHighlightApi();
    if (api) {
      api.registry.delete('mb-sentence');
      api.registry.delete('mb-word');
      api.registry.delete('mb-search');
    }
    this.speechLayer?.replaceChildren();
    this.searchLayer?.replaceChildren();
  }
}
