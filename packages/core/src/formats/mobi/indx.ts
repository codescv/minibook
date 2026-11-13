import { MiniBookError } from '../../errors.js';
import { BinaryReader, concatBytes, readMobiVarIntForward } from '../../io/binary.js';
import { decodeBytesWithEncoding } from '../../io/encoding.js';
import type { ByteSource } from '../../types.js';
import { readPdbRecord } from './pdb.js';

interface TagxRule {
  readonly tag: number;
  readonly numValues: number;
  readonly bitmask: number;
  readonly endFlag: number;
}

export interface IndxEntry {
  readonly label: string;
  readonly tags: Readonly<Record<number, readonly number[]>>;
}

export interface ParsedIndxTable {
  readonly entries: readonly IndxEntry[];
  readonly cncx: ReadonlyMap<number, string>;
  getCncxString(offset: number | undefined): string | undefined;
}

function countTrailingZeros32(mask: number): number {
  if (mask === 0) return 0;
  let m = mask >>> 0;
  let n = 0;
  while ((m & 1) === 0) {
    n++;
    m >>>= 1;
  }
  return n;
}

function parseCncxRecords(records: readonly Uint8Array[], encoding: 'utf-8' | 'windows-1252'): Map<number, string> {
  const map = new Map<number, string>();
  let recordBase = 0;
  for (const rec of records) {
    let pos = 0;
    while (pos < rec.byteLength) {
      // Skip 0x00 padding at end of a 64 KiB CNCX block
      if (rec[pos] === 0 && pos + 1 >= rec.byteLength) break;
      const entryOffset = recordBase + pos;
      let strLen: number;
      let nextPos: number;
      try {
        const res = readMobiVarIntForward(rec, pos);
        strLen = res.value;
        nextPos = res.nextOffset;
      } catch {
        break;
      }
      if (strLen === 0 && rec[pos] === 0) {
        pos++;
        continue;
      }
      const end = Math.min(rec.byteLength, nextPos + strLen);
      const str = decodeBytesWithEncoding(rec.subarray(nextPos, end), encoding);
      map.set(entryOffset, str);
      pos = end;
    }
    recordBase += 0x10000;
  }
  return map;
}

function parseTagxSection(bytes: Uint8Array, tagxOffset: number): {
  readonly numControlBytes: number;
  readonly rules: readonly TagxRule[];
} {
  if (tagxOffset <= 0 || tagxOffset + 12 > bytes.byteLength) {
    return { numControlBytes: 0, rules: [] };
  }
  const r = new BinaryReader(bytes);
  if (r.asciiAt(tagxOffset, 4) !== 'TAGX') {
    return { numControlBytes: 0, rules: [] };
  }
  const tagxLen = r.u32beAt(tagxOffset + 4);
  const numControlBytes = r.u32beAt(tagxOffset + 8);
  const rulesEnd = Math.min(bytes.byteLength, tagxOffset + tagxLen);
  const rules: TagxRule[] = [];
  for (let pos = tagxOffset + 12; pos + 4 <= rulesEnd; pos += 4) {
    rules.push({
      tag: bytes[pos]!,
      numValues: bytes[pos + 1]!,
      bitmask: bytes[pos + 2]!,
      endFlag: bytes[pos + 3]!,
    });
  }
  return { numControlBytes, rules };
}

function parseIndxLeafEntries(
  leafBytes: Uint8Array,
  numControlBytes: number,
  rules: readonly TagxRule[],
  encoding: 'utf-8' | 'windows-1252',
): IndxEntry[] {
  if (leafBytes.byteLength < 28) return [];
  const r = new BinaryReader(leafBytes);
  if (r.asciiAt(0, 4) !== 'INDX') return [];

  const idxtOffset = r.u32beAt(20);
  const entryCount = r.u32beAt(24);
  if (entryCount === 0 || idxtOffset <= 0 || idxtOffset + 4 > leafBytes.byteLength) {
    return [];
  }
  if (r.asciiAt(idxtOffset, 4) !== 'IDXT') {
    return [];
  }

  const out: IndxEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const ptrPos = idxtOffset + 4 + i * 2;
    if (ptrPos + 2 > leafBytes.byteLength) break;
    const entryStart = r.u16beAt(ptrPos);
    const nextEntryStart =
      i + 1 < entryCount && ptrPos + 4 <= leafBytes.byteLength
        ? r.u16beAt(ptrPos + 2)
        : idxtOffset;
    if (entryStart >= leafBytes.byteLength || entryStart >= nextEntryStart) continue;

    const labelLen = leafBytes[entryStart]!;
    let cursor = entryStart + 1;
    if (cursor + labelLen > nextEntryStart) continue;
    const label = decodeBytesWithEncoding(leafBytes.subarray(cursor, cursor + labelLen), encoding);
    cursor += labelLen;

    const tags: Record<number, number[]> = {};
    if (numControlBytes > 0 && rules.length > 0 && cursor + numControlBytes <= nextEntryStart) {
      const controlBytes = leafBytes.subarray(cursor, cursor + numControlBytes);
      cursor += numControlBytes;

      // Decode tag queue first (identifies whether each present tag has fixed count or byte-length)
      const pending: Array<{ tag: number; valueCount: number | null; byteCount: number | null }> = [];
      let controlIdx = 0;
      for (const rule of rules) {
        if (rule.endFlag === 1) {
          controlIdx++;
          continue;
        }
        if (controlIdx >= controlBytes.length) break;
        const cb = controlBytes[controlIdx]!;
        const masked = cb & rule.bitmask;
        if (masked === 0) continue;

        const shift = countTrailingZeros32(rule.bitmask);
        const fieldVal = masked >>> shift;
        const maxFieldVal = rule.bitmask >>> shift;

        if (fieldVal === maxFieldVal && maxFieldVal > 1) {
          const { value: byteCount, nextOffset } = readMobiVarIntForward(leafBytes, cursor);
          cursor = nextOffset;
          pending.push({ tag: rule.tag, valueCount: null, byteCount });
        } else {
          pending.push({ tag: rule.tag, valueCount: fieldVal * rule.numValues, byteCount: null });
        }
      }

      for (const item of pending) {
        const vals: number[] = tags[item.tag] ?? [];
        if (item.byteCount !== null) {
          const targetEnd = Math.min(nextEntryStart, cursor + item.byteCount);
          while (cursor < targetEnd) {
            const res = readMobiVarIntForward(leafBytes, cursor);
            vals.push(res.value);
            cursor = res.nextOffset;
          }
        } else if (item.valueCount !== null) {
          for (let k = 0; k < item.valueCount && cursor < nextEntryStart; k++) {
            const res = readMobiVarIntForward(leafBytes, cursor);
            vals.push(res.value);
            cursor = res.nextOffset;
          }
        }
        tags[item.tag] = vals;
      }
    }

    out.push({ label, tags });
  }

  return out;
}

/**
 * Parses a MOBI / KF8 `INDX` index table (meta-INDX + `1..N` leaf `INDX` records + `0..M` `CNCX`
 * string table records, or single-record `INDX`) (`ARCHITECTURE.md` §4.4).
 */
export async function readMobiIndxTable(
  src: ByteSource,
  recordOffsets: readonly number[],
  fileSize: number,
  metaRecordIndex: number,
): Promise<ParsedIndxTable> {
  const metaBytes = await readPdbRecord(src, recordOffsets, fileSize, metaRecordIndex);
  if (metaBytes.byteLength < 48) {
    throw new MiniBookError('corrupt-book', `INDX record ${metaRecordIndex} truncated`);
  }
  const mr = new BinaryReader(metaBytes);
  if (mr.asciiAt(0, 4) !== 'INDX') {
    throw new MiniBookError('corrupt-book', `Record ${metaRecordIndex} is not an INDX record`);
  }

  // MobileRead INDX header layout (`4..55`):
  //   4: headerLen, 8: nul1, 12: type (0=normal, 2=inflection/meta), 16: gen,
  //   20: idxtOffset, 24: count, 28: encoding, 32: language, 36: totalEntries,
  //   40: ordtOffset, 44: ligtOffset, 48: numLigt, 52: numCncx (`nctoc`), 180: tagxOffset
  const headerLen = mr.u32beAt(4);
  const indxType = metaBytes.byteLength >= 16 ? mr.u32beAt(12) : 0;
  const idxtOffset = mr.u32beAt(20);
  const countField = mr.u32beAt(24);
  const codepage = mr.u32beAt(28);
  const encoding: 'utf-8' | 'windows-1252' = codepage === 65001 ? 'utf-8' : 'windows-1252';
  const tagxOffset = headerLen >= 184 && metaBytes.byteLength >= 184 ? mr.u32beAt(180) : 0;
  const cncxCount = headerLen >= 56 && metaBytes.byteLength >= 56 ? mr.u32beAt(52) : 0;

  const { numControlBytes, rules } = parseTagxSection(metaBytes, tagxOffset);

  // Distinguish two-level meta-INDX (where `countField` is the number of secondary leaf INDX records)
  // vs single-record INDX (where leaf entries live directly in `metaBytes` and `countField` is entry count).
  // Child leaf INDX records never carry their own TAGX table (`nextTagxOffset === 0`), whereas an
  // adjacent independent INDX table (e.g. `frag` right after `skel`) has its own `TAGX` header!
  let isTwoLevel = indxType === 2;
  if (!isTwoLevel && countField > 0 && metaRecordIndex + 1 < recordOffsets.length) {
    const nextRec = await readPdbRecord(src, recordOffsets, fileSize, metaRecordIndex + 1);
    if (nextRec.byteLength >= 184) {
      const nr = new BinaryReader(nextRec);
      if (nr.asciiAt(0, 4) === 'INDX') {
        const nextHdrLen = nr.u32beAt(4);
        const nextTagxOff = nextHdrLen >= 184 ? nr.u32beAt(180) : 0;
        if (nextTagxOff === 0) {
          isTwoLevel = true;
        }
      }
    }
  }
  // Also check if `metaBytes` IDXT labels look like secondary index bounds (`0000`..`NNNN`) while next record is `INDX`
  if (isTwoLevel && countField > 0) {
    const entries: IndxEntry[] = [];
    for (let k = 1; k <= countField && metaRecordIndex + k < recordOffsets.length; k++) {
      const leafRec = await readPdbRecord(src, recordOffsets, fileSize, metaRecordIndex + k);
      entries.push(...parseIndxLeafEntries(leafRec, numControlBytes, rules, encoding));
    }
    const cncxRecords: Uint8Array[] = [];
    for (let c = 0; c < cncxCount; c++) {
      const recIdx = metaRecordIndex + countField + 1 + c;
      if (recIdx < recordOffsets.length) {
        cncxRecords.push(await readPdbRecord(src, recordOffsets, fileSize, recIdx));
      }
    }
    const cncx = parseCncxRecords(cncxRecords, encoding);
    return {
      entries,
      cncx,
      getCncxString: (off) => (off !== undefined ? cncx.get(off) : undefined),
    };
  }

  // Single-record INDX
  const entries =
    idxtOffset > 0 ? parseIndxLeafEntries(metaBytes, numControlBytes, rules, encoding) : [];
  const cncxRecords: Uint8Array[] = [];
  for (let c = 0; c < cncxCount; c++) {
    const recIdx = metaRecordIndex + 1 + c;
    if (recIdx < recordOffsets.length) {
      cncxRecords.push(await readPdbRecord(src, recordOffsets, fileSize, recIdx));
    }
  }
  const cncx = parseCncxRecords(cncxRecords, encoding);
  return {
    entries,
    cncx,
    getCncxString: (off) => (off !== undefined ? cncx.get(off) : undefined),
  };
}

/**
 * Parses KF8 `FDST` flow descriptor record (`ARCHITECTURE.md` §4.4 #1).
 */
export function parseFdstRecord(
  fdstBytes: Uint8Array,
  totalStreamLength: number,
): Array<{ readonly start: number; readonly end: number }> {
  if (fdstBytes.byteLength < 12) {
    return [{ start: 0, end: totalStreamLength }];
  }
  const r = new BinaryReader(fdstBytes);
  if (r.asciiAt(0, 4) !== 'FDST') {
    return [{ start: 0, end: totalStreamLength }];
  }
  const secOffset = r.u32beAt(4);
  const numFlows = r.u32beAt(8);
  if (numFlows === 0 || secOffset + numFlows * 8 > fdstBytes.byteLength) {
    return [{ start: 0, end: totalStreamLength }];
  }
  const flows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < numFlows; i++) {
    const start = Math.min(totalStreamLength, r.u32beAt(secOffset + i * 8));
    const end = Math.min(totalStreamLength, r.u32beAt(secOffset + i * 8 + 4));
    flows.push({ start, end: Math.max(start, end) });
  }
  return flows.length > 0 ? flows : [{ start: 0, end: totalStreamLength }];
}

export { concatBytes };
