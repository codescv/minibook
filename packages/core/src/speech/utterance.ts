import type { Utterance } from '../types.js';

/**
 * Parses an utterance ID `"<section>:<start>-<end>"` back into coordinates.
 */
export function parseUtteranceId(id: string): { readonly section: number; readonly start: number; readonly end: number } | null {
  const m = /^(\d+):(\d+)-(\d+)$/.exec(id.trim());
  if (!m) return null;
  return {
    section: Number.parseInt(m[1]!, 10),
    start: Number.parseInt(m[2]!, 10),
    end: Number.parseInt(m[3]!, 10),
  };
}

/**
 * Finds the utterance to start speaking from for a page's first visible offset (`ARCHITECTURE.md` §8.2):
 *   1. First utterance starting at `>= pageStartOffset` (if within the page's span), OR
 *   2. Utterance containing `pageStartOffset`, OR
 *   3. Closest utterance after `pageStartOffset`.
 */
export function findUtteranceAtOffset(
  utterances: readonly Utterance[],
  offset: number,
  preferContaining = false,
): Utterance | null {
  if (utterances.length === 0) return null;

  if (preferContaining) {
    const containing = utterances.find((u) => offset >= u.start && offset < u.end);
    if (containing) return containing;
  } else {
    const startingAtOrAfter = utterances.find((u) => u.start >= offset);
    if (startingAtOrAfter) {
      const containing = utterances.find((u) => offset > u.start && offset < u.end);
      return containing ?? startingAtOrAfter;
    }
  }

  for (const u of utterances) {
    if (u.end > offset) return u;
  }
  return utterances[utterances.length - 1] ?? null;
}

/**
 * Returns the first utterance of the previous or next paragraph (`blockIndex`),
 * used by long-press on `⏮` / `⏭` (`PRODUCT_DESIGN.md` §4.6).
 */
export function findAdjacentParagraphUtterance(
  utterances: readonly Utterance[],
  currentId: string,
  direction: -1 | 1,
): Utterance | null {
  const idx = utterances.findIndex((u) => u.id === currentId);
  if (idx < 0) return utterances[0] ?? null;
  const curBlock = utterances[idx]!.blockIndex;

  if (direction === 1) {
    for (let i = idx + 1; i < utterances.length; i++) {
      if (utterances[i]!.blockIndex !== curBlock) {
        return utterances[i]!;
      }
    }
    return null;
  }

  // Previous paragraph: find any utterance with a smaller `blockIndex`, then snap to the FIRST utterance of that block
  let prevBlockLastIdx = -1;
  for (let i = idx - 1; i >= 0; i--) {
    if (utterances[i]!.blockIndex !== curBlock) {
      prevBlockLastIdx = i;
      break;
    }
  }
  if (prevBlockLastIdx < 0) {
    // Already in first paragraph -> jump to first sentence of current paragraph
    let firstInCur = idx;
    while (firstInCur > 0 && utterances[firstInCur - 1]!.blockIndex === curBlock) {
      firstInCur--;
    }
    return utterances[firstInCur]!;
  }
  const targetBlock = utterances[prevBlockLastIdx]!.blockIndex;
  let firstInTarget = prevBlockLastIdx;
  while (firstInTarget > 0 && utterances[firstInTarget - 1]!.blockIndex === targetBlock) {
    firstInTarget--;
  }
  return utterances[firstInTarget]!;
}
