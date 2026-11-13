import { MiniBookError } from '../../errors.js';
import { BinaryReader, concatBytes } from '../../io/binary.js';

const MAX_HUFF_RECURSION_DEPTH = 32; // `ARCHITECTURE.md` §4.4, §13
const MAX_SINGLE_RECORD_EXPANDED = 4 * 1024 * 1024; // 4 MiB per record guard

interface Dict1Entry {
  readonly codeLen: number;
  readonly terminal: boolean;
  readonly maxcode: number;
}

interface CdicSlice {
  readonly bytes: Uint8Array;
  readonly entryOffsets: Uint16Array;
}

/**
 * Pure-TS MOBI HUFF/CDIC bitwise MSB-first decoder (`ARCHITECTURE.md` §4.4):
 *   - Parses `HUFF` 256-entry fast lookup table + 32-length `mincode`/`maxcode` table.
 *   - Parses `CDIC` dictionary slices (`codeLength` bits per slice).
 *   - Expands non-literal dictionary entries recursively with memoization and a hard depth-32 guard.
 */
export class HuffCdicDecoder {
  private readonly dict1: readonly Dict1Entry[];
  private readonly mincodes: Uint32Array;
  private readonly maxcodes: Uint32Array;
  private readonly codeLengthBits: number;
  private readonly sliceMask: number;
  private readonly cdics: readonly CdicSlice[];
  private readonly memo = new Map<number, Uint8Array>();

  constructor(huffRecord: Uint8Array, cdicRecords: readonly Uint8Array[]) {
    if (huffRecord.byteLength < 24) {
      throw new MiniBookError('corrupt-book', 'HUFF record shorter than 24 bytes');
    }
    const hr = new BinaryReader(huffRecord);
    if (hr.asciiAt(0, 4) !== 'HUFF') {
      throw new MiniBookError('corrupt-book', 'Invalid HUFF magic signature');
    }
    const off1 = hr.u32beAt(8);
    const off2 = hr.u32beAt(12);
    if (off1 + 256 * 4 > huffRecord.byteLength || off2 + 64 * 4 > huffRecord.byteLength) {
      throw new MiniBookError('corrupt-book', 'HUFF lookup tables extend past record end');
    }

    const dict1: Dict1Entry[] = [];
    for (let i = 0; i < 256; i++) {
      const v = hr.u32beAt(off1 + i * 4);
      dict1.push({
        codeLen: v & 0x1f,
        terminal: (v & 0x80) !== 0,
        maxcode: v >>> 8,
      });
    }
    this.dict1 = dict1;

    // 1-indexed `1..32`
    this.mincodes = new Uint32Array(33);
    this.maxcodes = new Uint32Array(33);
    this.maxcodes[0] = 0;
    for (let len = 1; len <= 32; len++) {
      const base = off2 + (len - 1) * 8;
      this.mincodes[len] = hr.u32beAt(base);
      this.maxcodes[len] = hr.u32beAt(base + 4);
    }

    if (cdicRecords.length === 0) {
      throw new MiniBookError('corrupt-book', 'HUFF/CDIC archive contains zero CDIC dictionary records');
    }

    let codeLengthBits = 0;
    const cdics: CdicSlice[] = [];
    for (const rec of cdicRecords) {
      if (rec.byteLength < 16) {
        throw new MiniBookError('corrupt-book', 'CDIC record shorter than 16 bytes');
      }
      const cr = new BinaryReader(rec);
      if (cr.asciiAt(0, 4) !== 'CDIC') {
        throw new MiniBookError('corrupt-book', 'Invalid CDIC magic signature');
      }
      const numEntries = cr.u32beAt(8);
      const bits = cr.u32beAt(12);
      if (bits < 1 || bits > 16) {
        throw new MiniBookError('corrupt-book', `Invalid CDIC codeLength ${bits}`);
      }
      if (codeLengthBits === 0) codeLengthBits = bits;
      const sliceCount = Math.min(numEntries, 1 << bits);
      if (16 + sliceCount * 2 > rec.byteLength) {
        throw new MiniBookError('corrupt-book', 'CDIC offset table truncated');
      }
      const offsets = new Uint16Array(sliceCount);
      for (let i = 0; i < sliceCount; i++) {
        offsets[i] = cr.u16beAt(16 + i * 2);
      }
      cdics.push({ bytes: rec, entryOffsets: offsets });
    }

    this.codeLengthBits = codeLengthBits;
    this.sliceMask = (1 << codeLengthBits) - 1;
    this.cdics = cdics;
  }

  decompress(data: Uint8Array): Uint8Array {
    return this.decodeBits(data, 0);
  }

  private readTop32Bits(data: Uint8Array, bitPos: number): number {
    const byteIdx = bitPos >>> 3;
    const bitShift = bitPos & 7;
    const b0 = data[byteIdx] ?? 0;
    const b1 = data[byteIdx + 1] ?? 0;
    const b2 = data[byteIdx + 2] ?? 0;
    const b3 = data[byteIdx + 3] ?? 0;
    const b4 = data[byteIdx + 4] ?? 0;
    if (bitShift === 0) {
      return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    }
    const hi = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
    return ((hi << bitShift) | (b4 >>> (8 - bitShift))) >>> 0;
  }

  private decodeBits(data: Uint8Array, depth: number): Uint8Array {
    if (depth > MAX_HUFF_RECURSION_DEPTH) {
      throw new MiniBookError('too-large', `HUFF/CDIC dictionary recursion exceeded depth ${MAX_HUFF_RECURSION_DEPTH}`);
    }

    const totalBits = data.byteLength * 8;
    let bitPos = 0;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (bitPos < totalBits) {
      const x = this.readTop32Bits(data, bitPos);
      const topByte = x >>> 24;
      const fast = this.dict1[topByte]!;
      let codeLen = fast.codeLen;
      let maxcode = fast.maxcode;

      if (!fast.terminal) {
        if (codeLen === 0) codeLen = 9;
        while (codeLen < 32 && (x >>> (32 - codeLen)) < this.mincodes[codeLen]!) {
          codeLen++;
        }
        maxcode = this.maxcodes[codeLen]!;
      }

      if (codeLen === 0 || bitPos + codeLen > totalBits) {
        // Padding bits at end of byte-aligned stream
        break;
      }

      bitPos += codeLen;
      const code = x >>> (32 - codeLen);
      const dictIndex = (maxcode - code) >>> 0;
      const expanded = this.resolveDictEntry(dictIndex, depth);
      totalBytes += expanded.byteLength;
      if (totalBytes > MAX_SINGLE_RECORD_EXPANDED) {
        throw new MiniBookError('too-large', 'HUFF/CDIC record expanded past 4 MiB limit');
      }
      chunks.push(expanded);
    }

    return concatBytes(chunks);
  }

  private resolveDictEntry(dictIndex: number, depth: number): Uint8Array {
    const memoHit = this.memo.get(dictIndex);
    if (memoHit) return memoHit;

    const sliceIdx = dictIndex >>> this.codeLengthBits;
    const entryIdx = dictIndex & this.sliceMask;
    const cdic = this.cdics[sliceIdx];
    if (!cdic || entryIdx >= cdic.entryOffsets.length) {
      throw new MiniBookError('corrupt-book', `HUFF/CDIC index ${dictIndex} out of bounds`);
    }

    const relOff = cdic.entryOffsets[entryIdx]!;
    const pos = 16 + relOff;
    if (pos + 2 > cdic.bytes.byteLength) {
      throw new MiniBookError('corrupt-book', 'Truncated CDIC dictionary entry');
    }

    const flagAndLen = (cdic.bytes[pos]! << 8) | cdic.bytes[pos + 1]!;
    const byteLen = flagAndLen & 0x7fff;
    const isLiteral = (flagAndLen & 0x8000) !== 0;

    if (pos + 2 + byteLen > cdic.bytes.byteLength) {
      throw new MiniBookError('corrupt-book', 'CDIC dictionary payload truncated');
    }
    const rawSlice = cdic.bytes.subarray(pos + 2, pos + 2 + byteLen);

    if (isLiteral) {
      this.memo.set(dictIndex, rawSlice);
      return rawSlice;
    }

    const expanded = this.decodeBits(rawSlice, depth + 1);
    this.memo.set(dictIndex, expanded);
    return expanded;
  }
}
