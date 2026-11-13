import { type DeflateOptions, deflateSync, Inflate } from 'fflate';
import { MiniBookError } from '../errors.js';
import type { ByteSource, ZipEntryIndex } from '../types.js';
import { safeDecodeUriComponent, normalizeArchivePath } from '../util/path.js';
import { BinaryReader, concatBytes } from './binary.js';

// Precomputed IEEE 802.3 CRC-32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// IBM Code Page 437 upper half (0x80..0xFF) per PKWARE ZIP specification
const CP437_HIGH =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5' +
  '\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192' +
  '\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510' +
  '\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567' +
  '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229' +
  '\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function decodeZipFileName(nameBytes: Uint8Array, flags: number): string {
  const utf8Flag = (flags & (1 << 11)) !== 0;
  if (utf8Flag) {
    return new TextDecoder('utf-8', { fatal: false }).decode(nameBytes);
  }
  try {
    return STRICT_UTF8.decode(nameBytes);
  } catch {
    let out = '';
    for (let i = 0; i < nameBytes.length; i++) {
      const b = nameBytes[i]!;
      out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80]!;
    }
    return out;
  }
}

export const MAX_ENTRY_BYTES_BINARY = 64 * 1024 * 1024; // 64 MiB (`ARCHITECTURE.md` §4.2)
export const MAX_ENTRY_BYTES_MARKUP = 16 * 1024 * 1024; // 16 MiB (`ARCHITECTURE.md` §4.2)
export const MAX_ZIP_RATIO = 200;
export const ZIP_RATIO_FLOOR_BYTES = 1024 * 1024; // 1 MiB

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;

export interface ZipReadEntryOptions {
  readonly maxBytes?: number;
  readonly skipCrcCheck?: boolean;
}

/**
 * Central-directory ZIP / ZIP64 reader (`ARCHITECTURE.md` §4.2).
 *
 * - Scans last `64 KiB + 22` bytes once to locate EOCD (+ ZIP64 EOCD locator if present).
 * - Reads central directory in one ranged `ByteSource.read` call; `entries` can be persisted
 *   inside `BookIndex` so reopening an EPUB performs **zero** central-directory reads.
 * - Reads each entry in a single ranged read (`localHeaderOffset` + 256-byte header slack + `compressedSize`).
 * - Defends against zip-bombs (both declared-size & spoofed-header streaming inflation),
 *   verifies CRC-32, and maps encrypted entries (`flags & 1`) to `drm-protected`.
 */
export class ZipArchive {
  readonly entries: readonly ZipEntryIndex[];
  private readonly src: ByteSource;
  private readonly exactMap = new Map<string, ZipEntryIndex>();
  private readonly normMap = new Map<string, ZipEntryIndex>();
  private readonly lowerMap = new Map<string, ZipEntryIndex>();

  constructor(src: ByteSource, entries: readonly ZipEntryIndex[]) {
    this.src = src;
    this.entries = entries;
    for (const entry of entries) {
      if (!this.exactMap.has(entry.name)) {
        this.exactMap.set(entry.name, entry);
      }
      const norm = normalizeArchivePath(entry.name);
      if (!this.normMap.has(norm)) {
        this.normMap.set(norm, entry);
      }
      const lower = norm.toLowerCase();
      if (!this.lowerMap.has(lower)) {
        this.lowerMap.set(lower, entry);
      }
    }
  }

  static async open(src: ByteSource, preloadedEntries?: readonly ZipEntryIndex[]): Promise<ZipArchive> {
    if (preloadedEntries) {
      return new ZipArchive(src, preloadedEntries);
    }
    const entries = await readCentralDirectory(src);
    return new ZipArchive(src, entries);
  }

  /**
   * Lookup order (`ARCHITECTURE.md` §4.2):
   *   1. Exact name
   *   2. Normalized archive path / percent-decoded
   *   3. Case-insensitive normalized path
   */
  findEntry(name: string): ZipEntryIndex | null {
    const exact = this.exactMap.get(name);
    if (exact) return exact;

    const norm = normalizeArchivePath(name);
    const byNorm = this.normMap.get(norm);
    if (byNorm) return byNorm;

    const decoded = normalizeArchivePath(safeDecodeUriComponent(name));
    const byDecoded = this.normMap.get(decoded);
    if (byDecoded) return byDecoded;

    const byLower = this.lowerMap.get(decoded.toLowerCase()) ?? this.lowerMap.get(norm.toLowerCase());
    return byLower ?? null;
  }

  hasEntry(name: string): boolean {
    return this.findEntry(name) !== null;
  }

  async readEntry(entryOrName: ZipEntryIndex | string, options?: ZipReadEntryOptions): Promise<Uint8Array> {
    const entry = typeof entryOrName === 'string' ? this.findEntry(entryOrName) : entryOrName;
    if (!entry) {
      throw new MiniBookError('not-found', `ZIP entry not found: ${String(entryOrName)}`);
    }

    // Encrypted entry -> `drm-protected` (`ARCHITECTURE.md` §4.2)
    if ((entry.flags & 0x0001) !== 0 || entry.compressionMethod === 99) {
      throw new MiniBookError('drm-protected', `ZIP entry "${entry.name}" is encrypted`);
    }

    const maxBytes = options?.maxBytes ?? MAX_ENTRY_BYTES_BINARY;
    if (entry.uncompressedSize > maxBytes) {
      throw new MiniBookError('too-large', `ZIP entry "${entry.name}" exceeds ${maxBytes} bytes (${entry.uncompressedSize})`);
    }
    if (
      entry.uncompressedSize > ZIP_RATIO_FLOOR_BYTES &&
      entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > MAX_ZIP_RATIO
    ) {
      throw new MiniBookError(
        'too-large',
        `ZIP entry "${entry.name}" exceeds ${MAX_ZIP_RATIO}:1 compression ratio (${entry.uncompressedSize}/${entry.compressedSize})`,
      );
    }

    // Read local file header (30 bytes + name + extra) + compressed payload in a single ranged read
    const slack = 256;
    const initialReadLen = Math.min(
      Math.max(0, this.src.size - entry.localHeaderOffset),
      30 + slack + entry.compressedSize,
    );
    const buf = await this.src.read(entry.localHeaderOffset, initialReadLen);
    if (buf.byteLength < 30) {
      throw new MiniBookError('corrupt-book', `Truncated local ZIP header for "${entry.name}"`);
    }
    const r = new BinaryReader(buf);
    const sig = r.u32leAt(0);
    if (sig !== SIG_LOCAL_FILE) {
      throw new MiniBookError('corrupt-book', `Invalid local ZIP header signature for "${entry.name}"`);
    }
    const localFlags = r.u16leAt(6);
    if ((localFlags & 0x0001) !== 0) {
      throw new MiniBookError('drm-protected', `ZIP entry "${entry.name}" is encrypted`);
    }
    const nameLen = r.u16leAt(26);
    const extraLen = r.u16leAt(28);
    const dataOffsetInBuf = 30 + nameLen + extraLen;
    const totalNeeded = dataOffsetInBuf + entry.compressedSize;

    let compressed: Uint8Array;
    if (totalNeeded <= buf.byteLength) {
      compressed = buf.subarray(dataOffsetInBuf, totalNeeded);
    } else {
      const payloadStart = entry.localHeaderOffset + dataOffsetInBuf;
      if (payloadStart + entry.compressedSize > this.src.size) {
        throw new MiniBookError('corrupt-book', `ZIP entry "${entry.name}" payload exceeds archive size`);
      }
      compressed = await this.src.read(payloadStart, entry.compressedSize);
      if (compressed.byteLength < entry.compressedSize) {
        throw new MiniBookError('corrupt-book', `Truncated ZIP payload for "${entry.name}"`);
      }
    }

    let raw: Uint8Array;
    if (entry.compressionMethod === 0) {
      raw = compressed;
      if (raw.byteLength > maxBytes) {
        throw new MiniBookError('too-large', `ZIP entry "${entry.name}" exceeds ${maxBytes} bytes`);
      }
    } else if (entry.compressionMethod === 8) {
      raw = inflateBounded(compressed, maxBytes, entry.name);
    } else {
      throw new MiniBookError(
        'unsupported-format',
        `Unsupported ZIP compression method ${entry.compressionMethod} on "${entry.name}"`,
      );
    }

    if (!options?.skipCrcCheck) {
      const actualCrc = crc32(raw);
      if (actualCrc !== (entry.crc32 >>> 0)) {
        throw new MiniBookError(
          'corrupt-book',
          `CRC-32 mismatch for "${entry.name}" (expected 0x${(entry.crc32 >>> 0).toString(16)}, got 0x${actualCrc.toString(16)})`,
        );
      }
    }

    return raw;
  }

  async readText(entryOrName: ZipEntryIndex | string, maxBytes = MAX_ENTRY_BYTES_MARKUP): Promise<string> {
    const bytes = await this.readEntry(entryOrName, { maxBytes });
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/**
 * Streams deflate chunks in <= 16 KiB increments so even a spoofed-header zip-bomb
 * (`uncompressedSize = 10` in header, 1 GiB in stream) aborts immediately at the cap.
 */
function inflateBounded(compressed: Uint8Array, maxBytes: number, entryName: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalOut = 0;
  const maxRatioLimit = Math.max(ZIP_RATIO_FLOOR_BYTES, compressed.byteLength * MAX_ZIP_RATIO);
  const hardCap = Math.min(maxBytes, maxRatioLimit);

  const inflater = new Inflate((chunk) => {
    totalOut += chunk.byteLength;
    if (totalOut > hardCap) {
      throw new MiniBookError(
        'too-large',
        `Decompressed ZIP entry "${entryName}" exceeded ${hardCap} bytes (zip-bomb / size cap)`,
      );
    }
    chunks.push(chunk);
  });

  const STEP = 16 * 1024;
  try {
    if (compressed.byteLength === 0) {
      inflater.push(compressed, true);
    } else {
      for (let off = 0; off < compressed.byteLength; off += STEP) {
        const end = Math.min(compressed.byteLength, off + STEP);
        inflater.push(compressed.subarray(off, end), end === compressed.byteLength);
      }
    }
  } catch (err) {
    if (err instanceof MiniBookError) throw err;
    throw new MiniBookError('corrupt-book', `Failed to inflate ZIP entry "${entryName}": ${(err as Error).message}`, {
      cause: err,
    });
  }

  return concatBytes(chunks);
}

async function readCentralDirectory(src: ByteSource): Promise<ZipEntryIndex[]> {
  if (src.size < 22) {
    throw new MiniBookError('corrupt-book', 'Archive too small to be a valid ZIP file');
  }
  const tailLen = Math.min(src.size, 65536 + 22 + 20);
  const tailOffset = src.size - tailLen;
  const tail = await src.read(tailOffset, tailLen);
  const tailReader = new BinaryReader(tail);

  let eocdPos = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
    ) {
      const commentLen = tailReader.u16leAt(i + 20);
      if (i + 22 + commentLen <= tail.byteLength) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) {
    throw new MiniBookError('corrupt-book', 'ZIP End-Of-Central-Directory signature not found');
  }

  let totalEntries = tailReader.u16leAt(eocdPos + 10);
  let cdSize = tailReader.u32leAt(eocdPos + 12);
  let cdOffset = tailReader.u32leAt(eocdPos + 16);

  // Check for ZIP64 EOCD Locator immediately preceding EOCD (20 bytes)
  if (eocdPos >= 20 && tailReader.u32leAt(eocdPos - 20) === SIG_ZIP64_LOCATOR) {
    const zip64EocdOffset = tailReader.u64leAt(eocdPos - 12);
    const z64Header = await src.read(zip64EocdOffset, 56);
    if (z64Header.byteLength >= 56) {
      const zr = new BinaryReader(z64Header);
      if (zr.u32leAt(0) === SIG_ZIP64_EOCD) {
        totalEntries = zr.u64leAt(32);
        cdSize = zr.u64leAt(40);
        cdOffset = zr.u64leAt(48);
      }
    }
  }

  if (cdSize > 64 * 1024 * 1024) {
    throw new MiniBookError('too-large', `ZIP central directory too large (${cdSize} bytes)`);
  }
  if (cdOffset + cdSize > src.size) {
    throw new MiniBookError('corrupt-book', 'ZIP central directory extends past end of file');
  }

  const cdBytes = await src.read(cdOffset, cdSize);
  if (cdBytes.byteLength < cdSize) {
    throw new MiniBookError('corrupt-book', 'Truncated ZIP central directory');
  }

  const cr = new BinaryReader(cdBytes);
  const entries: ZipEntryIndex[] = [];

  while (cr.remaining >= 46 && entries.length < Math.max(totalEntries, 65536)) {
    const pos = cr.offset;
    const sig = cr.u32leAt(pos);
    if (sig !== SIG_CENTRAL_DIR) break;

    const flags = cr.u16leAt(pos + 8);
    const compressionMethod = cr.u16leAt(pos + 10);
    const entryCrc = cr.u32leAt(pos + 16);
    let compressedSize = cr.u32leAt(pos + 20);
    let uncompressedSize = cr.u32leAt(pos + 24);
    const nameLen = cr.u16leAt(pos + 28);
    const extraLen = cr.u16leAt(pos + 30);
    const commentLen = cr.u16leAt(pos + 32);
    let localHeaderOffset = cr.u32leAt(pos + 42);

    const recordEnd = pos + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdBytes.byteLength) {
      throw new MiniBookError('corrupt-book', 'Truncated central directory entry');
    }

    const nameBytes = cr.sliceAt(pos + 46, nameLen);
    const name = decodeZipFileName(nameBytes, flags);

    // Parse ZIP64 extended information extra field (`0x0001`) if any 32-bit sentinel is `0xFFFFFFFF`
    if (
      extraLen >= 4 &&
      (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff)
    ) {
      let extraPos = pos + 46 + nameLen;
      const extraEnd = extraPos + extraLen;
      while (extraPos + 4 <= extraEnd) {
        const headerId = cr.u16leAt(extraPos);
        const dataSize = cr.u16leAt(extraPos + 2);
        let fieldCursor = extraPos + 4;
        const fieldEnd = Math.min(extraEnd, fieldCursor + dataSize);
        if (headerId === 0x0001) {
          if (uncompressedSize === 0xffffffff && fieldCursor + 8 <= fieldEnd) {
            uncompressedSize = cr.u64leAt(fieldCursor);
            fieldCursor += 8;
          }
          if (compressedSize === 0xffffffff && fieldCursor + 8 <= fieldEnd) {
            compressedSize = cr.u64leAt(fieldCursor);
            fieldCursor += 8;
          }
          if (localHeaderOffset === 0xffffffff && fieldCursor + 8 <= fieldEnd) {
            localHeaderOffset = cr.u64leAt(fieldCursor);
            fieldCursor += 8;
          }
          break;
        }
        extraPos += 4 + dataSize;
      }
    }

    // Skip directory entries ending with `/`
    if (!name.endsWith('/')) {
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
        crc32: entryCrc,
        flags,
      });
    }

    cr.seek(recordEnd);
  }

  return entries;
}

export interface ZipBuilderFile {
  readonly name: string;
  readonly data: Uint8Array | string;
  readonly store?: boolean;
  readonly flags?: number;
  readonly level?: DeflateOptions['level'];
}

/**
 * Pure-TS deterministic ZIP archive builder (used for generating spec-compliant EPUB,
 * `.fb2.zip`, and adversarial test fixtures without external CLI dependencies).
 */
export function buildZipArchive(files: readonly ZipBuilderFile[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const nameBytes = enc.encode(file.name);
    const hasNonAscii = nameBytes.some((b) => b >= 0x80);
    const flags = (file.flags ?? 0) | (hasNonAscii ? 1 << 11 : 0);
    const method = file.store ? 0 : 8;
    const compressed = method === 0 ? raw : deflateSync(raw, { level: file.level ?? 6 });
    const sum = crc32(raw);

    const localHeader = new Uint8Array(30 + nameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, SIG_LOCAL_FILE, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, compressed.byteLength, true);
    lv.setUint32(22, raw.byteLength, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const cdHeader = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, SIG_CENTRAL_DIR, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, compressed.byteLength, true);
    cv.setUint32(24, raw.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    localParts.push(localHeader, compressed);
    cdParts.push(cdHeader);
    offset += localHeader.byteLength + compressed.byteLength;
  }

  const cdBlock = concatBytes(cdParts);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdBlock.byteLength, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return concatBytes([...localParts, cdBlock, eocd]);
}
