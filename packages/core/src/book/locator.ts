import type { Locator, SavedPosition, SectionRef, SectionText } from '../types.js';

/**
 * Computes book-wide fraction `[0..1]` from section weights (`sizeHint`) and in-section offset
 * (`ARCHITECTURE.md` §5.4). Never requires whole-book pagination.
 */
export function fractionForLocator(
  spine: readonly SectionRef[],
  locator: Locator,
  currentSectionLength?: number,
): number {
  const linear = spine.filter((s) => s.linear || s.index === locator.section);
  if (linear.length === 0) return 0;
  const total = linear.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  if (total <= 0) return 0;

  let before = 0;
  let currentWeight = 1;
  for (const s of linear) {
    const w = Math.max(1, s.sizeHint);
    if (s.index < locator.section) {
      before += w;
    } else if (s.index === locator.section) {
      currentWeight = w;
      break;
    }
  }
  const denom = Math.max(1, currentSectionLength ?? currentWeight);
  const within = Math.max(0, Math.min(1, locator.offset / denom));
  return Math.max(0, Math.min(1, (before + within * currentWeight) / total));
}

/**
 * Maps a book-wide fraction `[0..1]` (e.g. from the scrubber or *Go to %*) to a `Locator`.
 */
export function locatorForFraction(spine: readonly SectionRef[], fraction: number): Locator {
  const clamped = Math.max(0, Math.min(1, fraction));
  const linear = spine.filter((s) => s.linear);
  const items = linear.length > 0 ? linear : spine;
  if (items.length === 0) return { section: 0, offset: 0 };

  const total = items.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  const target = clamped * total;
  let acc = 0;
  for (const s of items) {
    const w = Math.max(1, s.sizeHint);
    if (acc + w >= target) {
      const share = w > 0 ? Math.max(0, Math.min(1, (target - acc) / w)) : 0;
      return { section: s.index, offset: Math.floor(share * s.sizeHint) };
    }
    acc += w;
  }
  const last = items[items.length - 1]!;
  return { section: last.index, offset: Math.max(0, last.sizeHint) };
}

/**
 * Re-anchors a saved locator against `sectionText` (`ARCHITECTURE.md` §5.4):
 *   1. If `snippet` matches at `offset`, returns `offset`.
 *   2. Otherwise searches `±2,000` chars around `offset` for `snippet`.
 *   3. Otherwise falls back to proportional `fraction` inside the section.
 */
export function reanchorLocator(
  sectionText: SectionText,
  saved: Pick<SavedPosition, 'offset' | 'snippet' | 'fraction'>,
): number {
  const str = sectionText.text;
  if (str.length === 0) return 0;
  const clamped = Math.max(0, Math.min(str.length, saved.offset));
  const snippet = saved.snippet;
  if (!snippet) return clamped;

  if (str.slice(clamped, clamped + snippet.length) === snippet) {
    return clamped;
  }

  const radius = 2000;
  const winStart = Math.max(0, clamped - radius);
  const winEnd = Math.min(str.length, clamped + radius + snippet.length);
  const windowStr = str.slice(winStart, winEnd);

  let bestPos = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  let searchFrom = 0;
  while (searchFrom <= windowStr.length - snippet.length) {
    const idx = windowStr.indexOf(snippet, searchFrom);
    if (idx < 0) break;
    const absIdx = winStart + idx;
    const dist = Math.abs(absIdx - clamped);
    if (dist < bestDist) {
      bestDist = dist;
      bestPos = absIdx;
    }
    searchFrom = idx + 1;
  }
  if (bestPos >= 0) {
    return bestPos;
  }

  const fallbackFrac = Math.max(0, Math.min(1, saved.fraction));
  return Math.min(str.length, Math.floor(fallbackFrac * str.length));
}

export function createSavedPosition(
  spine: readonly SectionRef[],
  sectionText: SectionText,
  locator: Locator,
  nowMs = Date.now(),
): SavedPosition {
  const offset = Math.max(0, Math.min(sectionText.text.length, locator.offset));
  const snippet = sectionText.text.slice(offset, offset + 32);
  const fraction = fractionForLocator(spine, { section: locator.section, offset }, sectionText.text.length);
  return {
    section: locator.section,
    offset,
    fraction,
    snippet,
    updatedAt: nowMs,
  };
}
