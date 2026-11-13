import { MiniBookError } from '../../errors.js';
import { BinaryReader } from '../../io/binary.js';
import { decodeBytesWithEncoding } from '../../io/encoding.js';
import type { ByteSource, ReadingDirection } from '../../types.js';

export interface PdbContainer {
  readonly name: string;
  readonly typeCreator: string;
  readonly recordOffsets: readonly number[];
  readonly fileSize: number;
}

/**
 * Parses the 78-byte PalmDB header and `8 * recordCount` record offset table (`§4.4`).
 * Uses at most 2 bounded `ByteSource.read` calls.
 */
export async function readPdbContainer(src: ByteSource): Promise<PdbContainer> {
  if (src.size < 78) {
    throw new MiniBookError('corrupt-book', 'File too small for PalmDB header');
  }
  // Read first 64 KiB (covers PDB header + up to ~8,000 record entries in 1 call!)
  const firstRead = await src.read(0, Math.min(src.size, 65536));
  const r = new BinaryReader(firstRead);
  const name = r.cstrAt(0, 32);
  const typeCreator = r.asciiAt(60, 8);
  const recordCount = r.u16beAt(76);

  if (recordCount === 0) {
    throw new MiniBookError('corrupt-book', 'PalmDB contains zero records');
  }

  const tableEnd = 78 + recordCount * 8;
  if (tableEnd > src.size) {
    throw new MiniBookError('corrupt-book', 'PalmDB record offset table exceeds file size');
  }

  let tableBytes = firstRead;
  if (tableEnd > firstRead.byteLength) {
    tableBytes = await src.read(0, tableEnd);
  }
  const tr = new BinaryReader(tableBytes);
  const recordOffsets: number[] = [];
  for (let i = 0; i < recordCount; i++) {
    const off = tr.u32beAt(78 + i * 8);
    recordOffsets.push(off);
  }

  return {
    name,
    typeCreator,
    recordOffsets,
    fileSize: src.size,
  };
}

export function getPdbRecordByteRange(
  recordOffsets: readonly number[],
  fileSize: number,
  recordIndex: number,
): { readonly start: number; readonly end: number } {
  if (recordIndex < 0 || recordIndex >= recordOffsets.length) {
    throw new MiniBookError('corrupt-book', `PDB record index ${recordIndex} out of bounds (${recordOffsets.length})`);
  }
  const start = recordOffsets[recordIndex]!;
  let end = fileSize;
  for (let next = recordIndex + 1; next < recordOffsets.length; next++) {
    const cand = recordOffsets[next]!;
    if (cand >= start) {
      end = Math.min(fileSize, cand);
      break;
    }
  }
  if (start > fileSize || end < start) {
    throw new MiniBookError('corrupt-book', `Invalid PDB record range [${start}, ${end}) for record ${recordIndex}`);
  }
  return { start, end };
}

export async function readPdbRecord(
  src: ByteSource,
  recordOffsets: readonly number[],
  fileSize: number,
  recordIndex: number,
): Promise<Uint8Array> {
  const { start, end } = getPdbRecordByteRange(recordOffsets, fileSize, recordIndex);
  if (end <= start) return new Uint8Array(0);
  return src.read(start, end - start);
}

export interface ParsedExth {
  readonly authors: readonly string[];
  readonly updatedTitle?: string;
  readonly language?: string;
  readonly publisher?: string;
  readonly description?: string;
  readonly publishedAt?: string;
  readonly identifier?: string;
  readonly coverOffset?: number;
  readonly kf8BoundaryRecord?: number;
  readonly kf8CoverUri?: string;
  readonly direction?: ReadingDirection;
}

export interface ParsedMobiRecord0 {
  readonly compression: 1 | 2 | 17480;
  readonly textLength: number;
  readonly textRecordCount: number;
  readonly recordSize: number;
  readonly encryptionType: number;
  readonly encoding: 'utf-8' | 'windows-1252';
  readonly fileVersion: number;
  readonly uid: number;
  readonly title: string;
  readonly localeLang: string | null;
  readonly firstNonBookIndex: number;
  readonly firstImageIndex: number;
  readonly huffRecordIndex: number;
  readonly huffRecordCount: number;
  readonly extraDataFlags: number;
  readonly ncxIndex: number;
  readonly fdstIndex: number;
  readonly fdstCount: number;
  readonly fragIndex: number;
  readonly skelIndex: number;
  readonly guideIndex: number;
  readonly exth: ParsedExth;
}

const NONE_U32 = 0xffffffff;

const LOCALE_PRIMARY_MAP: Readonly<Record<number, string>> = {
  0x01: 'ar',
  0x04: 'zh',
  0x07: 'de',
  0x09: 'en',
  0x0a: 'es',
  0x0c: 'fr',
  0x0d: 'he',
  0x10: 'it',
  0x11: 'ja',
  0x12: 'ko',
  0x13: 'nl',
  0x15: 'pl',
  0x16: 'pt',
  0x19: 'ru',
};

function validIndex(v: number): number {
  return v === NONE_U32 ? -1 : v;
}

export function parseMobiRecord0(rec0: Uint8Array, fallbackName: string): ParsedMobiRecord0 {
  if (rec0.byteLength < 16) {
    throw new MiniBookError('corrupt-book', 'MOBI Record 0 shorter than 16-byte PalmDOC header');
  }
  const r = new BinaryReader(rec0);
  const rawCompression = r.u16beAt(0);
  const textLength = r.u32beAt(4);
  const textRecordCount = r.u16beAt(8);
  const recordSize = r.u16beAt(10) || 4096;
  const encryptionType = r.u16beAt(12);

  if (encryptionType !== 0) {
    throw new MiniBookError(
      'drm-protected',
      'This book is copy-protected and cannot be opened.',
      { details: { encryptionType } },
    );
  }

  if (rawCompression !== 1 && rawCompression !== 2 && rawCompression !== 17480) {
    throw new MiniBookError('unsupported-format', `Unsupported MOBI compression type ${rawCompression}`);
  }
  const compression = rawCompression as 1 | 2 | 17480;

  // Plain PalmDOC (`TEXtREAd`) without MOBI header
  if (rec0.byteLength < 24 || r.asciiAt(16, 4) !== 'MOBI') {
    return {
      compression,
      textLength,
      textRecordCount,
      recordSize,
      encryptionType: 0,
      encoding: 'windows-1252',
      fileVersion: 2,
      uid: 0,
      title: fallbackName || 'Untitled',
      localeLang: null,
      firstNonBookIndex: textRecordCount + 1,
      firstImageIndex: -1,
      huffRecordIndex: -1,
      huffRecordCount: 0,
      extraDataFlags: 0,
      ncxIndex: -1,
      fdstIndex: -1,
      fdstCount: 0,
      fragIndex: -1,
      skelIndex: -1,
      guideIndex: -1,
      exth: { authors: [] },
    };
  }

  const mobiHeaderLen = r.u32beAt(20);
  const mobiHeaderEnd = Math.min(rec0.byteLength, 16 + mobiHeaderLen);
  const codepage = mobiHeaderEnd >= 32 ? r.u32beAt(28) : 1252;
  const encoding: 'utf-8' | 'windows-1252' = codepage === 65001 ? 'utf-8' : 'windows-1252';
  const uid = mobiHeaderEnd >= 36 ? r.u32beAt(32) : 0;
  const fileVersion = mobiHeaderEnd >= 40 ? r.u32beAt(36) : 6;
  const firstNonBookIndex = mobiHeaderEnd >= 84 ? validIndex(r.u32beAt(80)) : -1;
  const fullNameOffset = mobiHeaderEnd >= 88 ? r.u32beAt(84) : 0;
  const fullNameLength = mobiHeaderEnd >= 92 ? r.u32beAt(88) : 0;
  const locale = mobiHeaderEnd >= 96 ? r.u32beAt(92) : 0;
  const localeLang = LOCALE_PRIMARY_MAP[locale & 0xff] ?? null;

  const firstImageIndex = mobiHeaderEnd >= 112 ? validIndex(r.u32beAt(108)) : -1;
  const huffRecordIndex = mobiHeaderEnd >= 116 ? validIndex(r.u32beAt(112)) : -1;
  const huffRecordCount = mobiHeaderEnd >= 120 ? r.u32beAt(116) : 0;
  const exthFlags = mobiHeaderEnd >= 132 ? r.u32beAt(128) : 0;

  let fdstIndex = -1;
  let fdstCount = 0;
  if (fileVersion >= 8 && mobiHeaderEnd >= 200) {
    fdstIndex = validIndex(r.u32beAt(192));
    fdstCount = r.u32beAt(196);
  }

  const extraDataFlags = mobiHeaderEnd >= 244 ? r.u16beAt(242) : 0;
  const ncxIndex = mobiHeaderEnd >= 248 ? validIndex(r.u32beAt(244)) : -1;

  let fragIndex = -1;
  let skelIndex = -1;
  let guideIndex = -1;
  if (fileVersion >= 8) {
    if (mobiHeaderEnd >= 252) fragIndex = validIndex(r.u32beAt(248));
    if (mobiHeaderEnd >= 256) skelIndex = validIndex(r.u32beAt(252));
    if (mobiHeaderEnd >= 264) guideIndex = validIndex(r.u32beAt(260));
  }

  let headerTitle = fallbackName;
  if (fullNameOffset > 0 && fullNameLength > 0 && fullNameOffset + fullNameLength <= rec0.byteLength) {
    const rawTitle = decodeBytesWithEncoding(
      rec0.subarray(fullNameOffset, fullNameOffset + fullNameLength),
      encoding,
    ).trim();
    if (rawTitle) headerTitle = rawTitle;
  }

  let exth: ParsedExth = { authors: [] };
  const exthStart = 16 + mobiHeaderLen;
  if ((exthFlags & 0x40) !== 0 && exthStart + 12 <= rec0.byteLength) {
    if (r.asciiAt(exthStart, 4) === 'EXTH') {
      exth = parseExthBlock(rec0.subarray(exthStart), encoding);
    }
  }

  const title = exth.updatedTitle || headerTitle || 'Untitled';

  return {
    compression,
    textLength,
    textRecordCount,
    recordSize,
    encryptionType,
    encoding,
    fileVersion,
    uid,
    title,
    localeLang,
    firstNonBookIndex,
    firstImageIndex,
    huffRecordIndex,
    huffRecordCount,
    extraDataFlags,
    ncxIndex,
    fdstIndex,
    fdstCount,
    fragIndex,
    skelIndex,
    guideIndex,
    exth,
  };
}

function parseExthBlock(exthBytes: Uint8Array, encoding: 'utf-8' | 'windows-1252'): ParsedExth {
  const r = new BinaryReader(exthBytes);
  const count = r.u32beAt(8);
  let pos = 12;

  const authors: string[] = [];
  let updatedTitle: string | undefined;
  let language: string | undefined;
  let publisher: string | undefined;
  let description: string | undefined;
  let publishedAt: string | undefined;
  let identifier: string | undefined;
  let coverOffset: number | undefined;
  let kf8BoundaryRecord: number | undefined;
  let kf8CoverUri: string | undefined;
  let direction: ReadingDirection | undefined;

  for (let i = 0; i < count && pos + 8 <= exthBytes.byteLength; i++) {
    const recType = r.u32beAt(pos);
    const recLen = r.u32beAt(pos + 4);
    if (recLen < 8 || pos + recLen > exthBytes.byteLength) break;
    const payload = exthBytes.subarray(pos + 8, pos + recLen);
    pos += recLen;

    const asStr = () => decodeBytesWithEncoding(payload, encoding).replace(/\0+$/, '').trim();
    const asU32 = () => (payload.byteLength >= 4 ? new BinaryReader(payload).u32beAt(0) : NONE_U32);

    switch (recType) {
      case 100: {
        const a = asStr();
        if (a) {
          for (const part of a.split(';').map((s) => s.trim()).filter(Boolean)) {
            authors.push(part);
          }
        }
        break;
      }
      case 101: {
        const v = asStr();
        if (v && !publisher) publisher = v;
        break;
      }
      case 103: {
        const v = asStr();
        if (v && !description) description = v;
        break;
      }
      case 106: {
        const v = asStr();
        if (v && !publishedAt) publishedAt = v;
        break;
      }
      case 113:
      case 504: {
        const v = asStr();
        if (v && !identifier) identifier = v;
        break;
      }
      case 121: {
        const v = asU32();
        if (v !== NONE_U32 && v > 0) kf8BoundaryRecord = v;
        break;
      }
      case 129: {
        const v = asStr();
        if (v) kf8CoverUri = v;
        break;
      }
      case 201: {
        const v = asU32();
        if (v !== NONE_U32) coverOffset = v;
        break;
      }
      case 503: {
        const v = asStr();
        if (v) updatedTitle = v;
        break;
      }
      case 524: {
        const v = asStr();
        if (v && !language) language = v;
        break;
      }
      case 527: {
        const v = asStr().toLowerCase();
        if (v === 'rtl') direction = 'rtl';
        else if (v === 'ltr') direction = 'ltr';
        break;
      }
      default:
        break;
    }
  }

  return {
    authors,
    ...(updatedTitle !== undefined ? { updatedTitle } : {}),
    ...(language !== undefined ? { language } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(identifier !== undefined ? { identifier } : {}),
    ...(coverOffset !== undefined ? { coverOffset } : {}),
    ...(kf8BoundaryRecord !== undefined ? { kf8BoundaryRecord } : {}),
    ...(kf8CoverUri !== undefined ? { kf8CoverUri } : {}),
    ...(direction !== undefined ? { direction } : {}),
  };
}
