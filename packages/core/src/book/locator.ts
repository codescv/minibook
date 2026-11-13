import type {
  BookSession,
  Locator,
  SavedPosition,
  SectionDoc,
  SectionRef,
  SectionText,
} from '../types.js';

export interface SectionFractionTarget {
  readonly section: number;
  /** Proportional character share `[0..1]` within `section`. */
  readonly share: number;
}

/**
 * Returns the full counted-character length of the section that `doc` belongs to,
 * even when `doc` is one of multiple `<= 40,000`-char virtual render units (`§4.8`).
 */
export function getSectionTotalChars(
  doc: Pick<SectionDoc, 'unit' | 'units' | 'text'>,
): number {
  if (doc.units && doc.units.length > 0) {
    return doc.units[doc.units.length - 1]!.end;
  }
  return Math.max(doc.unit.end, doc.text.text.length);
}

/**
 * Computes the observed `countedChars / sizeHint` ratio across spine sections whose
 * `charLength` is already known, clamped to `[0.1, 4.0]` (default `1.0` when none known).
 */
function observedCharsPerWeightRatio(spine: readonly SectionRef[]): number {
  let sumChars = 0;
  let sumHint = 0;
  for (const s of spine) {
    if (
      s.charLength !== undefined &&
      Number.isFinite(s.charLength) &&
      s.charLength > 0 &&
      s.sizeHint > 0
    ) {
      sumChars += s.charLength;
      sumHint += s.sizeHint;
    }
  }
  if (sumHint <= 0) return 1;
  return Math.max(0.1, Math.min(4.0, sumChars / sumHint));
}

function resolveSectionCharLength(
  spine: readonly SectionRef[],
  sec: SectionRef | undefined,
  override?: number | ((sectionIndex: number) => number | undefined),
  sectionIndex = sec?.index ?? 0,
): number {
  const explicit =
    typeof override === 'function' ? override(sectionIndex) : override;
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  if (
    sec?.charLength !== undefined &&
    Number.isFinite(sec.charLength) &&
    sec.charLength >= 0
  ) {
    return sec.charLength;
  }
  const baseHint = sec ? Math.max(1, sec.sizeHint) : 1;
  return Math.max(1, Math.round(baseHint * observedCharsPerWeightRatio(spine)));
}

/**
 * Computes book-wide fraction `[0..1]` from section weights (`sizeHint`) and
 * **character-accurate** within-section share (`offset / sectionCharLength`) (`ARCHITECTURE.md` §5.4).
 * Never requires whole-book pagination.
 */
export function fractionForLocator(
  spine: readonly SectionRef[],
  locator: Locator,
  currentSectionLength?: number | ((sectionIndex: number) => number | undefined),
): number {
  const linear = spine.filter((s) => s.linear || s.index === locator.section);
  if (linear.length === 0) return 0;
  const total = linear.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  if (total <= 0) return 0;

  let before = 0;
  let currentWeight = 1;
  let targetRef: SectionRef | undefined;
  for (const s of linear) {
    const w = Math.max(1, s.sizeHint);
    if (s.index < locator.section) {
      before += w;
    } else if (s.index === locator.section) {
      currentWeight = w;
      targetRef = s;
      break;
    }
  }

  const charDenom = resolveSectionCharLength(
    spine,
    targetRef ?? spine[locator.section],
    currentSectionLength,
    locator.section,
  );
  const within =
    charDenom <= 0 ? 0 : Math.max(0, Math.min(1, locator.offset / charDenom));
  return Math.max(0, Math.min(1, (before + within * currentWeight) / total));
}

/**
 * Maps a book-wide fraction `[0..1]` to `{ section, share }` where `share` is the
 * proportional `[0..1]` position inside `section` (`[P1-F1]`).
 */
export function sectionShareForFraction(
  spine: readonly SectionRef[],
  fraction: number,
): SectionFractionTarget {
  const clamped = Math.max(0, Math.min(1, fraction));
  const linear = spine.filter((s) => s.linear);
  const items = linear.length > 0 ? linear : spine;
  if (items.length === 0) return { section: 0, share: 0 };
  if (clamped <= 0) return { section: items[0]!.index, share: 0 };

  const total = items.reduce((acc, s) => acc + Math.max(1, s.sizeHint), 0);
  const target = clamped * total;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const s = items[i]!;
    const w = Math.max(1, s.sizeHint);
    if (acc + w >= target || i === items.length - 1) {
      const share = w > 0 ? Math.max(0, Math.min(1, (target - acc) / w)) : 0;
      return { section: s.index, share };
    }
    acc += w;
  }
  const last = items[items.length - 1]!;
  return { section: last.index, share: 1 };
}

/**
 * Maps a book-wide fraction `[0..1]` (e.g. from the scrubber or *Go to %*) to a character `Locator`.
 * Uses `charLengthOf` / `SectionRef.charLength` (falling back to `sizeHint * observedRatio`).
 */
export function locatorForFraction(
  spine: readonly SectionRef[],
  fraction: number,
  charLengthOf?: number | ((sectionIndex: number) => number | undefined),
): Locator {
  const { section, share } = sectionShareForFraction(spine, fraction);
  const secRef = spine[section] ?? spine.find((s) => s.index === section);
  const charLen = resolveSectionCharLength(spine, secRef, charLengthOf, section);
  return {
    section,
    offset: Math.max(0, Math.round(share * charLen)),
  };
}

/**
 * Async resolver for scrubber / *Go to %* that guarantees exact counted-character landing
 * even when jumping into a previously unloaded section of a cold-opened book (`[P1-F1]`).
 */
export async function resolveLocatorForFraction(
  session: Pick<BookSession, 'spine' | 'loadSection' | 'loadSectionText'>,
  fraction: number,
): Promise<Locator> {
  const { section, share } = sectionShareForFraction(session.spine, fraction);
  const secRef =
    session.spine[section] ?? session.spine.find((s) => s.index === section);
  let charLen = secRef?.charLength;
  if (charLen === undefined) {
    if (session.loadSectionText) {
      charLen = (await session.loadSectionText(section)).text.length;
    } else {
      charLen = getSectionTotalChars(await session.loadSection(section, 0));
    }
  }
  return {
    section,
    offset: Math.max(0, Math.round(share * charLen)),
  };
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
