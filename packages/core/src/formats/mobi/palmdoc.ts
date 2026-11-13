import { readMobiVarIntBackward } from '../../io/binary.js';

/**
 * Strips MOBI extra trailing record entries (`ARCHITECTURE.md` §4.4):
 *   1. For every set bit in `extraDataFlags` above bit 0 (highest bit 15 down to 1):
 *      read a backward-encoded variable-width `size` at the current record end and drop `size` bytes.
 *   2. If bit 0 (`multibyte overlap`) is set: drop `(lastByte & 3) + 1` bytes.
 */
export function stripMobiTrailingEntries(record: Uint8Array, extraDataFlags: number): Uint8Array {
  if (extraDataFlags === 0 || record.byteLength === 0) return record;
  let end = record.byteLength;

  for (let bit = 15; bit >= 1; bit--) {
    if ((extraDataFlags & (1 << bit)) !== 0 && end > 0) {
      const { value: size } = readMobiVarIntBackward(record, end);
      if (size > 0 && size <= end) {
        end -= size;
      }
    }
  }

  if ((extraDataFlags & 1) !== 0 && end > 0) {
    const overlap = (record[end - 1]! & 0x03) + 1;
    end = Math.max(0, end - overlap);
  }

  return end === record.byteLength ? record : record.subarray(0, end);
}

/**
 * PalmDOC LZ77 decompression (`ARCHITECTURE.md` §4.4):
 *   - `0x00`: literal `0x00`
 *   - `0x01..0x08`: copy next `b` bytes literally
 *   - `0x09..0x7F`: literal `b`
 *   - `0x80..0xBF`: 2-byte back-reference (`distance = ((pair & 0x3fff) >>> 3)`, `length = (pair & 7) + 3`);
 *                   overlapping byte-by-byte copy supported!
 *   - `0xC0..0xFF`: `' '` (`0x20`) followed by `b ^ 0x80`
 */
export function decompressPalmDoc(input: Uint8Array): Uint8Array {
  let cap = Math.max(4096, input.byteLength * 2);
  let out = new Uint8Array(cap);
  let outPos = 0;

  const ensureSpace = (needed: number) => {
    if (outPos + needed <= cap) return;
    while (outPos + needed > cap) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(out.subarray(0, outPos));
    out = grown;
  };

  let i = 0;
  const n = input.byteLength;
  while (i < n) {
    const b = input[i++]!;
    if (b === 0x00 || (b >= 0x09 && b <= 0x7f)) {
      ensureSpace(1);
      out[outPos++] = b;
    } else if (b >= 0x01 && b <= 0x08) {
      const count = Math.min(b, n - i);
      ensureSpace(count);
      for (let k = 0; k < count; k++) {
        out[outPos++] = input[i++]!;
      }
    } else if (b >= 0x80 && b <= 0xbf) {
      if (i >= n) break;
      const next = input[i++]!;
      const pair = ((b << 8) | next) & 0x3fff;
      const distance = pair >>> 3;
      const length = (pair & 0x07) + 3;
      if (distance === 0 || distance > outPos) {
        continue;
      }
      ensureSpace(length);
      let srcIdx = outPos - distance;
      for (let k = 0; k < length; k++) {
        out[outPos++] = out[srcIdx++]!;
      }
    } else {
      // `0xC0..0xFF`: space + (b ^ 0x80)
      ensureSpace(2);
      out[outPos++] = 0x20;
      out[outPos++] = b ^ 0x80;
    }
  }

  return out.subarray(0, outPos);
}

/**
 * Pure-TS PalmDOC LZ77 compressor (used for round-trip tests and building realistic `.mobi`/`.azw3` fixtures).
 */
export function compressPalmDoc(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const n = raw.byteLength;

  while (i < n) {
    // 1. Try LZ77 back-reference (`distance` in `1..2047`, `length` in `3..10`)
    let bestLen = 0;
    let bestDist = 0;
    const maxLen = Math.min(10, n - i);
    if (maxLen >= 3 && i > 0) {
      const searchStart = Math.max(0, i - 2047);
      for (let pos = i - 1; pos >= searchStart; pos--) {
        if (raw[pos] !== raw[i]) continue;
        let matchLen = 1;
        while (matchLen < maxLen && raw[pos + matchLen] === raw[i + matchLen]) {
          matchLen++;
        }
        if (matchLen > bestLen) {
          bestLen = matchLen;
          bestDist = i - pos;
          if (bestLen === 10) break;
        }
      }
    }

    if (bestLen >= 3) {
      const code = 0x8000 | (bestDist << 3) | (bestLen - 3);
      out.push((code >>> 8) & 0xff, code & 0xff);
      i += bestLen;
      continue;
    }

    const b = raw[i]!;
    // 2. Space + printable ASCII (`0x40..0x7F`) -> single byte `0xC0..0xFF`
    if (b === 0x20 && i + 1 < n) {
      const next = raw[i + 1]!;
      if (next >= 0x40 && next <= 0x7f) {
        out.push(next ^ 0x80);
        i += 2;
        continue;
      }
    }

    // 3. Direct literal (`0x00` or `0x09..0x7F`)
    if (b === 0x00 || (b >= 0x09 && b <= 0x7f)) {
      out.push(b);
      i++;
      continue;
    }

    // 4. High/binary byte run (`0x01..0x08` literal count prefix)
    let runEnd = i + 1;
    while (
      runEnd < n &&
      runEnd - i < 8 &&
      !(raw[runEnd] === 0x00 || (raw[runEnd]! >= 0x09 && raw[runEnd]! <= 0x7f))
    ) {
      runEnd++;
    }
    const count = runEnd - i;
    out.push(count);
    for (let k = i; k < runEnd; k++) {
      out.push(raw[k]!);
    }
    i = runEnd;
  }

  return Uint8Array.from(out);
}
