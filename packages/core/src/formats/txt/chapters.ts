import type { ByteSource, TxtChapterIndexEntry } from '../../types.js';

/**
 * Heading heuristic (`ARCHITECTURE.md` §4.6):
 *   - Line <= 50 chars matching Chinese/English chapter/part/prologue/epilogue patterns.
 *   - Accepted ONLY when there are >= 3 heading candidates AND median chapter >= 500 chars.
 *   - Sections > 30,000 chars split at paragraph/line `\n` boundaries into <= 30,000-char parts.
 *   - Files without accepted headings split into "Part 1 … N" of ~20,000 chars (<= 30,000 chars).
 */
export const TXT_HEADING_REGEX =
  /^\s*(?:第[零〇一二两三四五六七八九十百千万\d]+[章节回卷集部篇]|卷[零〇一二两三四五六七八九十百千万\d]+|Chapter\s+\d+|CHAPTER\s+[IVXLCDM\d]+|Part\s+\w+|序[章言]?|楔子|引子|前言|后记|尾声|番外)(?:$|[\s：:、.—\-—_].*)/;

export const MAX_TXT_SECTION_CHARS = 30_000;
export const TARGET_HEADINGLESS_PART_CHARS = 20_000;
const STREAM_CHUNK_BYTES = 1024 * 1024; // 1 MiB (`ARCHITECTURE.md` §4.6)

export function isTxtHeadingCandidate(line: string): boolean {
  const trimmed = line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  return TXT_HEADING_REGEX.test(trimmed);
}

interface ScannedLine {
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly charCount: number;
  readonly isBlank: boolean;
  readonly headingTitle: string | null;
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Streams a `ByteSource` in 1 MiB chunks, decoding line-by-line at `0x0A` (`\n`) boundaries
 * (`0x0A` is never a trail byte in UTF-8, GB18030, Big5, Shift_JIS, EUC-KR, or Windows-1252).
 * Peak memory is O(line metadata + 1 MiB chunk), never holding the whole decoded novel string.
 */
export async function buildStreamingTxtChapterIndex(
  src: ByteSource,
  encoding: string,
  bomLength = 0,
): Promise<TxtChapterIndexEntry[]> {
  if (src.size <= bomLength) {
    return [
      {
        index: 0,
        title: 'Part 1',
        byteStart: bomLength,
        byteEnd: src.size,
        charCount: 0,
        hasHeadingLine: false,
      },
    ];
  }

  const lineDecoder = new TextDecoder(encoding, { fatal: false });
  const lines: ScannedLine[] = [];
  const headingLineIndices: number[] = [];

  let fileOffset = bomLength;
  let leftover: Uint8Array = new Uint8Array(0);
  let lineByteStart = bomLength;

  const processLineBytes = (lineBytes: Uint8Array, byteStart: number, byteEnd: number) => {
    const decoded = lineDecoder.decode(lineBytes);
    const cleanLine = decoded.endsWith('\r') ? decoded.slice(0, -1) : decoded;
    const trimmed = cleanLine.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    const isBlank = trimmed.length === 0;
    const headingTitle = !isBlank && trimmed.length <= 50 && TXT_HEADING_REGEX.test(trimmed) ? trimmed : null;
    const idx = lines.length;
    lines.push({
      byteStart,
      byteEnd,
      charCount: cleanLine.length + 1,
      isBlank,
      headingTitle,
    });
    if (headingTitle !== null) {
      headingLineIndices.push(idx);
    }
  };

  while (fileOffset < src.size) {
    const toRead = Math.min(STREAM_CHUNK_BYTES, src.size - fileOffset);
    const chunk = await src.read(fileOffset, toRead);
    if (chunk.byteLength === 0) break;

    let buf: Uint8Array;
    if (leftover.byteLength > 0) {
      buf = new Uint8Array(leftover.byteLength + chunk.byteLength);
      buf.set(leftover, 0);
      buf.set(chunk, leftover.byteLength);
    } else {
      buf = chunk;
    }

    let scanStart = 0;
    for (let i = 0; i < buf.byteLength; i++) {
      if (buf[i] === 0x0a) {
        const lineSlice = buf.subarray(scanStart, i);
        const lineByteEnd = lineByteStart + (i - scanStart) + 1;
        processLineBytes(lineSlice, lineByteStart, lineByteEnd);
        scanStart = i + 1;
        lineByteStart = lineByteEnd;
      }
    }

    leftover = scanStart < buf.byteLength ? buf.slice(scanStart) : new Uint8Array(0);
    fileOffset += chunk.byteLength;
  }

  if (leftover.byteLength > 0) {
    processLineBytes(leftover, lineByteStart, src.size);
  }

  if (lines.length === 0) {
    return [
      {
        index: 0,
        title: 'Part 1',
        byteStart: bomLength,
        byteEnd: src.size,
        charCount: 0,
        hasHeadingLine: false,
      },
    ];
  }

  // Decide whether heading candidates meet `>= 3` AND `median >= 500` chars (`ARCHITECTURE.md` §4.6)
  let useHeadings = false;
  if (headingLineIndices.length >= 3) {
    const chapterLengths: number[] = [];
    for (let h = 0; h < headingLineIndices.length; h++) {
      const startLi = headingLineIndices[h]!;
      const endLi = h + 1 < headingLineIndices.length ? headingLineIndices[h + 1]! : lines.length;
      let chars = 0;
      for (let li = startLi; li < endLi; li++) {
        chars += lines[li]!.charCount;
      }
      chapterLengths.push(chars);
    }
    if (medianOf(chapterLengths) >= 500) {
      useHeadings = true;
    }
  }

  const result: TxtChapterIndexEntry[] = [];

  const splitLineSpan = (
    startLi: number,
    endLi: number,
    baseTitle: string,
    firstHasHeading: boolean,
    targetMaxChars: number,
    hardMaxChars: number,
    numberAllParts: boolean,
  ) => {
    if (startLi >= endLi) return;
    let totalChars = 0;
    for (let li = startLi; li < endLi; li++) totalChars += lines[li]!.charCount;

    if (!numberAllParts && totalChars <= hardMaxChars) {
      result.push({
        index: result.length,
        title: baseTitle,
        byteStart: lines[startLi]!.byteStart,
        byteEnd: lines[endLi - 1]!.byteEnd,
        charCount: totalChars,
        hasHeadingLine: firstHasHeading,
      });
      return;
    }

    let curStartLi = startLi;
    let partNumber = 1;
    const rawParts: Array<{ startLi: number; endLi: number; chars: number }> = [];

    while (curStartLi < endLi) {
      let accChars = 0;
      let cutLi = curStartLi;
      let lastBlankBreakLi = -1;

      while (cutLi < endLi) {
        const lineLen = lines[cutLi]!.charCount;
        if (cutLi > curStartLi && accChars + lineLen > hardMaxChars) {
          break;
        }
        accChars += lineLen;
        if (lines[cutLi]!.isBlank && accChars >= Math.floor(targetMaxChars * 0.6)) {
          lastBlankBreakLi = cutLi + 1;
        }
        cutLi++;
        if (accChars >= targetMaxChars && lastBlankBreakLi > curStartLi) {
          cutLi = lastBlankBreakLi;
          break;
        }
        if (accChars >= hardMaxChars) {
          break;
        }
      }

      if (cutLi <= curStartLi) cutLi = curStartLi + 1;
      let sliceChars = 0;
      for (let k = curStartLi; k < cutLi; k++) sliceChars += lines[k]!.charCount;
      rawParts.push({ startLi: curStartLi, endLi: cutLi, chars: sliceChars });
      curStartLi = cutLi;
    }

    for (let p = 0; p < rawParts.length; p++) {
      const part = rawParts[p]!;
      const title = numberAllParts
        ? `Part ${partNumber}`
        : rawParts.length === 1
          ? baseTitle
          : `${baseTitle} (${partNumber})`;
      result.push({
        index: result.length,
        title,
        byteStart: lines[part.startLi]!.byteStart,
        byteEnd: lines[part.endLi - 1]!.byteEnd,
        charCount: part.chars,
        hasHeadingLine: p === 0 && firstHasHeading,
      });
      partNumber++;
    }
  };

  if (useHeadings) {
    const firstHeadingLi = headingLineIndices[0]!;
    // Optional preamble before first heading if non-blank
    let preambleNonBlank = false;
    for (let li = 0; li < firstHeadingLi; li++) {
      if (!lines[li]!.isBlank) {
        preambleNonBlank = true;
        break;
      }
    }
    if (preambleNonBlank) {
      splitLineSpan(0, firstHeadingLi, 'Prologue', false, MAX_TXT_SECTION_CHARS, MAX_TXT_SECTION_CHARS, false);
    }

    for (let h = 0; h < headingLineIndices.length; h++) {
      const startLi = headingLineIndices[h]!;
      const endLi = h + 1 < headingLineIndices.length ? headingLineIndices[h + 1]! : lines.length;
      const title = lines[startLi]!.headingTitle ?? `Chapter ${h + 1}`;
      splitLineSpan(startLi, endLi, title, true, MAX_TXT_SECTION_CHARS, MAX_TXT_SECTION_CHARS, false);
    }
  } else {
    splitLineSpan(
      0,
      lines.length,
      'Part',
      false,
      TARGET_HEADINGLESS_PART_CHARS,
      MAX_TXT_SECTION_CHARS,
      true,
    );
  }

  return result;
}
