import type { SectionText, TextBlock, Utterance } from '../types.js';
import { containsCjkCharacters, resolveUtteranceLang } from './lang.js';

export interface SegmentOptions {
  readonly bookLang?: string | null;
  /** Optional Locator char offset to start segmentation at or containing (`§8.2`). */
  readonly startOffset?: number;
  /** When true (mid-book start), splits the first utterance > 80 chars at a clause mark (`§8.1 #6`). */
  readonly splitFirstLongUtterance?: boolean;
}

export const PAUSE_SENTENCE_MS = 200;
export const PAUSE_PARAGRAPH_MS = 450;
export const PAUSE_HEADING_MS = 800;
export const PAUSE_SECTION_END_MS = 1200;

const CJK_TERMINATORS = new Set(['。', '！', '？', '…', '；', '．', '‥']);
const CLOSING_PUNCT = new Set(['”', '’', '」', '』', '）', ')', '】', ']', '》', '〉', '"', "'"]);
const OPENING_QUOTES: Readonly<Record<string, string>> = {
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
};
const CLAUSE_MARKS = new Set(['，', '、', '；', '：', ',', ';', ':', '—', '–']);

// Known Latin abbreviations after which `.` does NOT end a sentence (`ARCHITECTURE.md` §8.1 #3)
const LATIN_ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'prof',
  'st',
  'mt',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'cf',
  'al',
  'no',
  'nos',
  'fig',
  'figs',
  'vol',
  'vols',
  'ch',
  'pt',
  'sec',
  'inc',
  'ltd',
  'co',
  'corp',
  'jr',
  'sr',
  'rev',
  'gen',
  'col',
  'capt',
  'sgt',
  'approx',
  'dept',
  'est',
  'min',
  'max',
]);

function isWhitespaceCode(c: number): boolean {
  return (
    c === 0x20 ||
    c === 0x09 ||
    c === 0x0a ||
    c === 0x0d ||
    c === 0x00a0 ||
    c === 0x3000
  );
}

function trimRange(str: string, rawStart: number, rawEnd: number): { start: number; end: number } | null {
  let s = rawStart;
  let e = rawEnd;
  while (s < e && isWhitespaceCode(str.charCodeAt(s))) s++;
  while (e > s && isWhitespaceCode(str.charCodeAt(e - 1))) e--;
  return e > s ? { start: s, end: e } : null;
}

/**
 * Finds short quoted spans (`< 12` chars inside `“...”`, `「...」`, `『...』`) so we never split
 * inside a short exclamation/dialogue tag (`ARCHITECTURE.md` §8.1 #4).
 */
function findShortQuoteSpans(str: string, blockStart: number, blockEnd: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = blockStart; i < blockEnd; i++) {
    const ch = str[i]!;
    const expectedClose = OPENING_QUOTES[ch];
    if (!expectedClose) continue;
    const closeIdx = str.indexOf(expectedClose, i + 1);
    if (closeIdx > i && closeIdx < blockEnd) {
      const innerLen = closeIdx - (i + 1);
      if (innerLen < 12) {
        spans.push({ start: i, end: closeIdx + 1 });
      }
      i = closeIdx;
    }
  }
  return spans;
}

function isInsideShortQuote(pos: number, spans: readonly { start: number; end: number }[]): boolean {
  for (const sp of spans) {
    if (pos > sp.start && pos < sp.end - 1) return true;
  }
  return false;
}

function isAbbreviationOrNumberDot(str: string, dotIndex: number, blockStart: number, blockEnd: number): boolean {
  // Decimal / version number: digit before AND digit after (`3.14`, `1.2.3`)
  const prevChar = dotIndex > blockStart ? str[dotIndex - 1]! : '';
  const nextChar = dotIndex + 1 < blockEnd ? str[dotIndex + 1]! : '';
  if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
    return true;
  }

  // URL / domain / email (`example.com`, `a@b.org`, `e.g.`)
  if (nextChar && /[a-z0-9/_-]/i.test(nextChar) && !/\s/.test(nextChar)) {
    return true;
  }

  // Extract token immediately preceding `.`
  let tokStart = dotIndex;
  while (tokStart > blockStart && /[A-Za-z.]/.test(str[tokStart - 1]!)) {
    tokStart--;
  }
  const rawToken = str.slice(tokStart, dotIndex);
  if (!rawToken) return false;

  const lowerToken = rawToken.toLowerCase().replace(/\.+$/, '');
  if (LATIN_ABBREVIATIONS.has(lowerToken) || LATIN_ABBREVIATIONS.has(rawToken.toLowerCase())) {
    return true;
  }

  // Single capital initial (`J.`, `U.S.`)
  if (/^[A-Z]$/.test(rawToken) || /^(?:[A-Z]\.)+[A-Z]$/.test(rawToken)) {
    return true;
  }

  return false;
}

function isSentenceStartChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) return true; // A-Z
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  if (ch === '"' || ch === "'" || ch === '“' || ch === '‘' || ch === '「' || ch === '『' || ch === '(' || ch === '（' || ch === '[') {
    return true;
  }
  // Any non-ASCII letter (accented uppercase, CJK, Kana, Cyrillic, etc.)
  if (code >= 0x00c0) {
    return ch === ch.toUpperCase() || code >= 0x3000;
  }
  return false;
}

function splitBlockRawSentences(fullText: string, blockStart: number, blockEnd: number): Array<{ start: number; end: number }> {
  const shortQuotes = findShortQuoteSpans(fullText, blockStart, blockEnd);
  const rawRanges: Array<{ start: number; end: number }> = [];
  let segStart = blockStart;
  let i = blockStart;

  while (i < blockEnd) {
    const ch = fullText[i]!;

    // Explicit hard newline inside `<pre>` or multi-line block acts as a sentence break
    if (ch === '\n') {
      // Only break on `\n` if followed by another `\n` or inside pre-like lines; single soft wrap in HTML prose is whitespace
      if (i + 1 < blockEnd && fullText[i + 1] === '\n') {
        const trimmed = trimRange(fullText, segStart, i);
        if (trimmed) rawRanges.push(trimmed);
        while (i < blockEnd && fullText[i] === '\n') i++;
        segStart = i;
        continue;
      }
    }

    const isCjkTerm = CJK_TERMINATORS.has(ch);
    const isAsciiBangQuest = ch === '!' || ch === '?';
    const isLatinDot = ch === '.';

    if (!isCjkTerm && !isAsciiBangQuest && !isLatinDot) {
      i++;
      continue;
    }

    // Consume contiguous run of terminators (`？！`, `……`, `...`, `?!`)
    let runEnd = i + 1;
    if (isLatinDot && fullText[i + 1] === '.' && fullText[i + 2] === '.') {
      while (runEnd < blockEnd && fullText[runEnd] === '.') runEnd++;
    } else if (isCjkTerm || isAsciiBangQuest) {
      while (
        runEnd < blockEnd &&
        (CJK_TERMINATORS.has(fullText[runEnd]!) || fullText[runEnd] === '!' || fullText[runEnd] === '?')
      ) {
        runEnd++;
      }
    }

    // Check Latin `.` guards (`§8.1 #3`)
    if (isLatinDot && runEnd === i + 1) {
      if (isAbbreviationOrNumberDot(fullText, i, blockStart, blockEnd)) {
        i = runEnd;
        continue;
      }
    }

    // Attach trailing closing quotes / brackets (`” ’ 」 』 ） 】 》 " ' )`, `§8.1 #2`)
    let afterClosers = runEnd;
    while (afterClosers < blockEnd && CLOSING_PUNCT.has(fullText[afterClosers]!)) {
      // Only attach ASCII `'` or `"` if an unmatched quote opened inside `[segStart, runEnd)` or if preceded by space-less punctuation
      const closer = fullText[afterClosers]!;
      if (closer === "'" && afterClosers + 1 < blockEnd && /[a-zA-Z]/.test(fullText[afterClosers + 1]!)) {
        break;
      }
      afterClosers++;
    }

    // Short-quote guard (`§8.1 #4`: do NOT split inside `< 12`-char quotation)
    const enclosingShortQuote = shortQuotes.find((sp) => i > sp.start && i < sp.end - 1);
    if (enclosingShortQuote && afterClosers < enclosingShortQuote.end && afterClosers < blockEnd) {
      i = runEnd;
      continue;
    }

    // For Latin `. ! ?` (not CJK terminators), verify boundary is end-of-block OR followed by whitespace + sentence start (or CJK char)
    if (!isCjkTerm && afterClosers < blockEnd) {
      const nextImmediate = fullText[afterClosers]!;
      const nextIsCjk = containsCjkCharacters(nextImmediate);
      if (!nextIsCjk) {
        if (!isWhitespaceCode(nextImmediate.charCodeAt(0))) {
          i = runEnd;
          continue;
        }
        let peek = afterClosers;
        while (peek < blockEnd && isWhitespaceCode(fullText.charCodeAt(peek))) peek++;
        if (peek < blockEnd && !isSentenceStartChar(fullText[peek]!)) {
          i = runEnd;
          continue;
        }
      }
    }

    const trimmed = trimRange(fullText, segStart, afterClosers);
    if (trimmed) {
      rawRanges.push(trimmed);
    }
    segStart = afterClosers;
    i = afterClosers;
  }

  const tail = trimRange(fullText, segStart, blockEnd);
  if (tail) {
    rawRanges.push(tail);
  }

  return rawRanges;
}

/**
 * Splits a single clause/sentence at the clause mark nearest the middle (`§8.1 #5`),
 * falling back to whitespace nearest the middle, then safe UTF-16 codepoint boundary.
 */
function splitOnceNearMiddle(
  fullText: string,
  start: number,
  end: number,
  preferEarlyForFirstUtterance = false,
): Array<{ start: number; end: number }> {
  const len = end - start;
  const targetOffset = preferEarlyForFirstUtterance
    ? start + Math.min(60, Math.floor(len * 0.4))
    : start + (len >>> 1);

  let bestClauseCut = -1;
  let bestClauseDist = Number.POSITIVE_INFINITY;
  const minMargin = Math.min(12, Math.floor(len * 0.15));

  for (let i = start + minMargin; i < end - minMargin; i++) {
    const ch = fullText[i]!;
    if (CLAUSE_MARKS.has(ch)) {
      let cut = i + 1;
      while (cut < end && CLOSING_PUNCT.has(fullText[cut]!)) cut++;
      if (cut < end) {
        const dist = Math.abs(cut - targetOffset);
        if (dist < bestClauseDist) {
          bestClauseDist = dist;
          bestClauseCut = cut;
        }
      }
    }
  }

  if (bestClauseCut > start && bestClauseCut < end) {
    const left = trimRange(fullText, start, bestClauseCut);
    const right = trimRange(fullText, bestClauseCut, end);
    if (left && right) return [left, right];
  }

  // Fallback: whitespace nearest middle
  let bestWsCut = -1;
  let bestWsDist = Number.POSITIVE_INFINITY;
  for (let i = start + minMargin; i < end - minMargin; i++) {
    if (isWhitespaceCode(fullText.charCodeAt(i))) {
      const dist = Math.abs(i - targetOffset);
      if (dist < bestWsDist) {
        bestWsDist = dist;
        bestWsCut = i;
      }
    }
  }
  if (bestWsCut > start && bestWsCut < end) {
    const left = trimRange(fullText, start, bestWsCut);
    const right = trimRange(fullText, bestWsCut, end);
    if (left && right) return [left, right];
  }

  // Hard cut (avoid splitting surrogate pair!)
  let mid = start + (len >>> 1);
  const code = fullText.charCodeAt(mid - 1);
  if (code >= 0xd800 && code <= 0xdbff && mid < end) {
    mid++;
  }
  const left = trimRange(fullText, start, mid);
  const right = trimRange(fullText, mid, end);
  if (left && right) return [left, right];
  return [{ start, end }];
}

function enforceMaxLength(
  fullText: string,
  range: { start: number; end: number },
): Array<{ start: number; end: number }> {
  const slice = fullText.slice(range.start, range.end);
  const maxLen = containsCjkCharacters(slice) ? 200 : 400; // `ARCHITECTURE.md` §8.1 #5
  if (range.end - range.start <= maxLen) {
    return [range];
  }
  const halves = splitOnceNearMiddle(fullText, range.start, range.end, false);
  if (halves.length === 1) return halves;
  return [
    ...enforceMaxLength(fullText, halves[0]!),
    ...enforceMaxLength(fullText, halves[1]!),
  ];
}

/**
 * Merges fragments `< 6` chars into the following sentence of the same block (`§8.1 #5`),
 * preserving `u.text === fullText.slice(u.start, u.end)` by spanning `[a.start, b.end)`.
 */
function mergeShortFragments(
  fullText: string,
  ranges: readonly { start: number; end: number }[],
): Array<{ start: number; end: number }> {
  if (ranges.length <= 1) return [...ranges];
  const merged: Array<{ start: number; end: number }> = [];
  let i = 0;

  while (i < ranges.length) {
    let cur = ranges[i]!;
    while (cur.end - cur.start < 6 && i + 1 < ranges.length) {
      const next = ranges[i + 1]!;
      // Only merge if combined length stays reasonable
      if (next.end - cur.start <= 420) {
        cur = { start: cur.start, end: next.end };
        i++;
      } else {
        break;
      }
    }
    merged.push(cur);
    i++;
  }

  // If the final fragment in a multi-sentence block is `< 6` chars, merge into predecessor
  if (merged.length >= 2) {
    const last = merged[merged.length - 1]!;
    const prev = merged[merged.length - 2]!;
    if (last.end - last.start < 6 && last.end - prev.start <= 420) {
      merged.splice(merged.length - 2, 2, { start: prev.start, end: last.end });
    }
  }

  // Verify `trimRange` invariants
  return merged
    .map((r) => trimRange(fullText, r.start, r.end))
    .filter((r): r is { start: number; end: number } => r !== null);
}

/**
 * Deterministic, DOM-free sentence segmenter (`ARCHITECTURE.md` §8.1).
 *
 * Guarantees for EVERY returned utterance `u`:
 *   `u.text === sectionText.text.slice(u.start, u.end)`
 */
export function segmentSection(
  sectionIndex: number,
  sectionText: SectionText,
  options?: SegmentOptions,
): Utterance[] {
  const fullText = sectionText.text;
  if (fullText.length === 0) return [];

  const blocks: readonly TextBlock[] =
    sectionText.blocks.length > 0
      ? sectionText.blocks
      : [{ start: 0, end: fullText.length, kind: 'p', lang: null }];

  const minOffset = options?.startOffset ?? 0;
  const splitFirstLong =
    options?.splitFirstLongUtterance ?? (options?.startOffset !== undefined && options.startOffset > 0);

  const pending: Array<{
    start: number;
    end: number;
    blockIndex: number;
    blockKind: TextBlock['kind'];
    blockLang: string | null;
    isLastInBlock: boolean;
  }> = [];

  for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
    const block = blocks[bIdx]!;
    if (block.end <= minOffset) continue;

    const rawSentences = splitBlockRawSentences(fullText, block.start, block.end);
    const lengthBounded: Array<{ start: number; end: number }> = [];
    for (const s of rawSentences) {
      lengthBounded.push(...enforceMaxLength(fullText, s));
    }
    const merged = mergeShortFragments(fullText, lengthBounded);

    // Filter out sentences completely preceding `minOffset` (keep the sentence containing or starting >= `minOffset`)
    const filtered = merged.filter((r) => r.end > minOffset);
    for (let sIdx = 0; sIdx < filtered.length; sIdx++) {
      let item = filtered[sIdx]!;

      // First-utterance rule (`§8.1 #6`): if mid-book playback starts on an utterance > 80 chars,
      // split once at a clause mark so first audio arrives sooner!
      if (pending.length === 0 && splitFirstLong && item.end - item.start > 80) {
        const pair = splitOnceNearMiddle(fullText, item.start, item.end, true);
        if (pair.length === 2) {
          const p0 = pair[0]!;
          const p1 = pair[1]!;
          if (p0.end > minOffset) {
            pending.push({
              start: p0.start,
              end: p0.end,
              blockIndex: bIdx,
              blockKind: block.kind,
              blockLang: block.lang,
              isLastInBlock: false,
            });
          }
          item = p1;
        }
      }

      pending.push({
        start: item.start,
        end: item.end,
        blockIndex: bIdx,
        blockKind: block.kind,
        blockLang: block.lang,
        isLastInBlock: sIdx === filtered.length - 1,
      });
    }
  }

  const utterances: Utterance[] = [];
  for (let idx = 0; idx < pending.length; idx++) {
    const p = pending[idx]!;
    const isSectionEnd = idx === pending.length - 1;
    let pauseAfterMs = PAUSE_SENTENCE_MS;
    if (isSectionEnd) {
      pauseAfterMs = PAUSE_SECTION_END_MS;
    } else if (p.blockKind === 'h') {
      pauseAfterMs = PAUSE_HEADING_MS;
    } else if (p.isLastInBlock) {
      pauseAfterMs = PAUSE_PARAGRAPH_MS;
    }

    const slice = fullText.slice(p.start, p.end);
    const lang = resolveUtteranceLang(slice, p.blockLang, options?.bookLang);

    utterances.push({
      id: `${sectionIndex}:${p.start}-${p.end}`,
      section: sectionIndex,
      start: p.start,
      end: p.end,
      blockIndex: p.blockIndex,
      text: slice,
      lang,
      pauseAfterMs,
    });
  }

  return utterances;
}
