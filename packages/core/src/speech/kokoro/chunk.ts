/**
 * Post-G2P token chunking (`TTS_V2_SPEC.md` §4.6, §4.9):
 *   - Budgets strictly on post-G2P token count (`KOKORO_TARGET_CHUNK_TOKENS = 150`,
 *     `KOKORO_MAX_CHUNK_TOKENS = 400`, model hard cap `510`).
 *   - Splits near midpoint at clause/sentence punctuation (`, . ! ? ; : — …`), else `/` or `' '`,
 *     else at a safe syllable boundary.
 *   - Invariants guaranteed:
 *     1. Every emitted ID is in `KOKORO_VOCAB` (`1..177`).
 *     2. Every chunk has `1 <= chunk.length <= KOKORO_MAX_CHUNK_TOKENS`.
 *     3. `chunks.flat()` equals the exact unsplit token stream.
 *     4. No chunk ever starts with a tone digit (`1..5`) or `'R'`.
 *     5. Every `KokoroWordSpan` is rebased to its chunk `[0, chunk.length]` with `0 <= c0 <= c1 <= rawTextLength`.
 */
import type { KokoroWordSpan } from '../../types.js';
import type { PhonemePiece } from './en-g2p.js';
import { KOKORO_PAD_TOKEN_ID, KOKORO_VOCAB } from './vocab.js';

export const KOKORO_TARGET_CHUNK_TOKENS = 150;
export const KOKORO_MAX_CHUNK_TOKENS = 400;

const PUNCT_SPLIT_CHARS = new Set([',', '.', '!', '?', ';', ':', '—', '…']);
const FORBIDDEN_CHUNK_START_CHARS = new Set(['1', '2', '3', '4', '5', 'R']);

export interface ChunkedKokoroTokens {
  readonly allIds: readonly number[];
  readonly chunks: readonly (readonly number[])[];
  readonly chunkSpans: readonly (readonly KokoroWordSpan[])[];
}

function isForbiddenStart(chars: readonly string[], idx: number): boolean {
  const ch = chars[idx];
  return ch !== undefined && FORBIDDEN_CHUNK_START_CHARS.has(ch);
}

function pickBestSplitIndex(
  chars: readonly string[],
  lo: number,
  hi: number,
  maxTokens: number,
): number | null {
  const len = hi - lo;
  const mid = (lo + hi) >> 1;
  const minMargin = Math.min(20, Math.max(1, Math.floor(len * 0.15)));
  const searchLo = lo + minMargin;
  const searchHi = hi - minMargin;

  // Tier 1: split right after `, . ! ? ; : — …` (consuming a trailing `' '` if present)
  let bestPunct: number | null = null;
  let bestPunctDist = Infinity;
  for (let i = searchLo; i < searchHi; i++) {
    if (PUNCT_SPLIT_CHARS.has(chars[i - 1]!)) {
      let cand = i;
      if (cand < searchHi && chars[cand] === ' ') {
        cand++;
      }
      if (cand > lo && cand < hi && !isForbiddenStart(chars, cand)) {
        const d = Math.abs(cand - mid);
        if (d < bestPunctDist) {
          bestPunctDist = d;
          bestPunct = cand;
        }
      }
    }
  }
  if (bestPunct !== null) return bestPunct;

  // Tier 2: split right after `/` (zh word boundary) or `' '` (en word boundary)
  let bestWord: number | null = null;
  let bestWordDist = Infinity;
  for (let i = searchLo; i < searchHi; i++) {
    const prev = chars[i - 1];
    if ((prev === '/' || prev === ' ') && !isForbiddenStart(chars, i)) {
      const d = Math.abs(i - mid);
      if (d < bestWordDist) {
        bestWordDist = d;
        bestWord = i;
      }
    }
  }
  if (bestWord !== null) return bestWord;

  // If already within hard cap `maxTokens`, keep as single chunk rather than splitting mid-word
  if (len <= maxTokens) return null;

  // Tier 3 (pathological > maxTokens single word): split right after a tone digit `1..5` or any non-forbidden start
  let bestSafe: number | null = null;
  let bestSafeDist = Infinity;
  for (let i = lo + 1; i < hi; i++) {
    if (!isForbiddenStart(chars, i)) {
      const prevTone = '12345'.includes(chars[i - 1] ?? '');
      const penalty = prevTone ? 0 : 50;
      const d = Math.abs(i - mid) + penalty;
      if (d < bestSafeDist) {
        bestSafeDist = d;
        bestSafe = i;
      }
    }
  }
  if (bestSafe !== null) return bestSafe;

  // Last resort if the entire remainder were tone digits / 'R' (impossible in real G2P, safe fallback)
  return mid > lo ? mid : lo + 1;
}

function collectChunkRanges(
  chars: readonly string[],
  lo: number,
  hi: number,
  targetTokens: number,
  maxTokens: number,
  out: Array<[number, number]>,
): void {
  if (hi <= lo) return;
  if (hi - lo <= targetTokens) {
    out.push([lo, hi]);
    return;
  }
  const splitAt = pickBestSplitIndex(chars, lo, hi, maxTokens);
  if (splitAt === null || splitAt <= lo || splitAt >= hi) {
    out.push([lo, hi]);
    return;
  }
  collectChunkRanges(chars, lo, splitAt, targetTokens, maxTokens, out);
  collectChunkRanges(chars, splitAt, hi, targetTokens, maxTokens, out);
}

export function encodeAndChunkKokoroPieces(
  pieces: readonly PhonemePiece[],
  rawTextLength: number,
  opts?: { readonly targetTokens?: number; readonly maxTokens?: number },
): ChunkedKokoroTokens {
  const targetTokens = opts?.targetTokens ?? KOKORO_TARGET_CHUNK_TOKENS;
  const maxTokens = opts?.maxTokens ?? KOKORO_MAX_CHUNK_TOKENS;

  const allIds: number[] = [];
  const allChars: string[] = [];
  const unsplitSpans: KokoroWordSpan[] = [];

  for (const p of pieces) {
    const t0 = allIds.length;
    for (const ch of p.phonemes) {
      const id = KOKORO_VOCAB[ch];
      if (id !== undefined && id !== KOKORO_PAD_TOKEN_ID) {
        // Guard: never allow a stream-initial token to be a tone digit or 'R'
        if (allIds.length === 0 && FORBIDDEN_CHUNK_START_CHARS.has(ch)) {
          continue;
        }
        allIds.push(id);
        allChars.push(ch);
      }
    }
    const t1 = allIds.length;
    if (p.c0 !== undefined && p.c1 !== undefined && t1 > t0 && rawTextLength > 0) {
      const c0 = Math.max(0, Math.min(rawTextLength, p.c0));
      const c1 = Math.max(c0, Math.min(rawTextLength, p.c1));
      if (c1 > c0) {
        unsplitSpans.push({ t0, t1, c0, c1 });
      }
    }
  }

  if (allIds.length === 0) {
    return { allIds: [], chunks: [], chunkSpans: [] };
  }

  const ranges: Array<[number, number]> = [];
  collectChunkRanges(allChars, 0, allIds.length, targetTokens, maxTokens, ranges);

  const chunks: number[][] = [];
  const chunkSpans: KokoroWordSpan[][] = [];

  for (const [lo, hi] of ranges) {
    const chunkLen = hi - lo;
    chunks.push(allIds.slice(lo, hi));
    const localSpans: KokoroWordSpan[] = [];
    for (const sp of unsplitSpans) {
      if (sp.t1 <= lo || sp.t0 >= hi) continue;
      const t0 = Math.max(0, sp.t0 - lo);
      const t1 = Math.min(chunkLen, sp.t1 - lo);
      if (t1 > t0) {
        localSpans.push({ t0, t1, c0: sp.c0, c1: sp.c1 });
      }
    }
    chunkSpans.push(localSpans);
  }

  return { allIds, chunks, chunkSpans };
}
