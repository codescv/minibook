import type { Locator, Utterance } from '@minibook/core';

export interface AutoPageTurnViewAdapter {
  readonly visibleSection: number;
  readonly visibleUnitRange?: { readonly start: number; readonly end: number };
  currentPage(): number;
  pageOf(sectionOffset: number): number;
  countCharsOnPage(sectionStart: number, sectionEnd: number, page: number): number;
  goToPage(page: number): void;
  jumpToLocator(locator: Locator): void;
}

function isOffsetInsideVisibleUnit(
  adapter: AutoPageTurnViewAdapter,
  section: number,
  offset: number,
): boolean {
  if (section !== adapter.visibleSection) return false;
  const u = adapter.visibleUnitRange;
  if (!u || u.end <= u.start) return true;
  return offset >= u.start && offset < u.end;
}

/**
 * Coordinates automatic page turns during Read Aloud (`ARCHITECTURE.md` §8.7):
 * - Turns immediately when `utterance-start` lands on another section or page.
 * - When a single sentence straddles a page boundary (`pageOf(u.end - 1) > pageOf(u.start)`):
 *   - turns as soon as an `utterance-word` boundary crosses onto `> currentPage`, OR
 *   - turns proportionally after `duration(u) * (charsOnFirstPage / u.length)` using
 *     attached audio duration or calibrated EMA characters-per-second `cps[lang]`.
 */
export class AutoPageTurn {
  private readonly cpsByLang = new Map<string, number>();
  private straddleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeUtterance: Utterance | null = null;
  private utteranceStartedAtMs = 0;

  private defaultCps(lang: string): number {
    return /^(zh|ja|ko)/i.test(lang) ? 4.8 : 14.5;
  }

  getCps(lang: string): number {
    const key = (lang.split('-')[0] ?? 'en').toLowerCase();
    return this.cpsByLang.get(key) ?? this.defaultCps(key);
  }

  recordUtteranceElapsed(utterance: Utterance, elapsedMs: number, rate: number): void {
    if (elapsedMs < 150 || utterance.text.length < 4) return;
    const key = (utterance.lang.split('-')[0] ?? 'en').toLowerCase();
    const measuredAt1x = (utterance.text.length / (elapsedMs / 1000)) / Math.max(0.5, rate);
    if (!Number.isFinite(measuredAt1x) || measuredAt1x < 1 || measuredAt1x > 45) return;
    const prev = this.getCps(key);
    this.cpsByLang.set(key, prev * 0.75 + measuredAt1x * 0.25);
  }

  onUtteranceStart(
    utterance: Utterance,
    adapter: AutoPageTurnViewAdapter | null,
    options: {
      readonly rate: number;
      readonly attachedDurationMs?: number;
      readonly suppressBackwardSnap?: boolean;
      readonly now?: number;
    },
  ): void {
    this.clearTimer();
    const now = options.now ?? Date.now();
    if (this.activeUtterance && this.utteranceStartedAtMs > 0) {
      this.recordUtteranceElapsed(this.activeUtterance, now - this.utteranceStartedAtMs, options.rate);
    }
    this.activeUtterance = utterance;
    this.utteranceStartedAtMs = now;

    if (!adapter) return;

    if (!isOffsetInsideVisibleUnit(adapter, utterance.section, utterance.start)) {
      adapter.jumpToLocator({ section: utterance.section, offset: utterance.start });
      return;
    }

    const startPage = adapter.pageOf(utterance.start);
    if (!options.suppressBackwardSnap && startPage !== adapter.currentPage()) {
      adapter.goToPage(startPage);
    } else if (options.suppressBackwardSnap && startPage > adapter.currentPage()) {
      adapter.goToPage(startPage);
    }

    const lastCharOffset = Math.max(utterance.start, utterance.end - 1);
    const unitRange = adapter.visibleUnitRange;
    const crossesUnitBoundary =
      Boolean(unitRange && unitRange.end > unitRange.start && lastCharOffset >= unitRange.end);
    const endPage = crossesUnitBoundary ? startPage + 1 : adapter.pageOf(lastCharOffset);

    if (crossesUnitBoundary || endPage > startPage) {
      const totalChars = Math.max(1, utterance.text.length);
      const effectiveEndInUnit = crossesUnitBoundary && unitRange ? unitRange.end : utterance.end;
      const charsOnFirst = Math.min(
        totalChars,
        Math.max(1, adapter.countCharsOnPage(utterance.start, effectiveEndInUnit, startPage)),
      );
      const rate = Math.max(0.5, options.rate);
      const estTotalMs =
        options.attachedDurationMs !== undefined && options.attachedDurationMs > 0
          ? options.attachedDurationMs / rate
          : (totalChars / (this.getCps(utterance.lang) * rate)) * 1000;

      const delayMs = Math.max(60, Math.round(estTotalMs * (charsOnFirst / totalChars)));
      this.straddleTimer = setTimeout(() => {
        this.straddleTimer = null;
        if (this.activeUtterance?.id !== utterance.id) return;
        if (crossesUnitBoundary && unitRange) {
          adapter.jumpToLocator({ section: utterance.section, offset: unitRange.end });
        } else if (adapter.visibleSection === utterance.section && adapter.currentPage() === startPage) {
          adapter.goToPage(startPage + 1);
        }
      }, delayMs);
    }
  }

  onUtteranceWord(
    utterance: Utterance,
    wordRelativeStart: number,
    adapter: AutoPageTurnViewAdapter | null,
  ): void {
    if (!adapter || utterance.section !== adapter.visibleSection) return;
    const wordSectionOffset = utterance.start + Math.max(0, wordRelativeStart);
    if (!isOffsetInsideVisibleUnit(adapter, utterance.section, wordSectionOffset)) {
      this.clearTimer();
      adapter.jumpToLocator({ section: utterance.section, offset: wordSectionOffset });
      return;
    }
    const wordPage = adapter.pageOf(wordSectionOffset);
    if (wordPage > adapter.currentPage()) {
      this.clearTimer();
      adapter.goToPage(wordPage);
    }
  }

  clearTimer(): void {
    if (this.straddleTimer !== null) {
      clearTimeout(this.straddleTimer);
      this.straddleTimer = null;
    }
  }

  reset(): void {
    this.clearTimer();
    this.activeUtterance = null;
    this.utteranceStartedAtMs = 0;
  }
}
