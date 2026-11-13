import { unzlibSync } from 'fflate';
import { MiniBookError } from '../../errors.js';
import { memoryByteSource } from '../../io/ByteSource.js';
import { BinaryReader, concatBytes } from '../../io/binary.js';
import type { BookResource, ByteSource } from '../../types.js';
import { mimeFromMagic } from '../../util/path.js';
import { HuffCdicDecoder } from './huffcdic.js';
import { decompressPalmDoc, stripMobiTrailingEntries } from './palmdoc.js';
import { getPdbRecordByteRange, type ParsedMobiRecord0, readPdbRecord } from './pdb.js';

export const MAX_MOBI_TEXT_BYTES = 64 * 1024 * 1024; // 64 MiB (`ARCHITECTURE.md` §4.4)
const COALESCE_READ_BYTES = 1024 * 1024; // <= 1 MiB coalesced ranged reads (`§4.4`)
const DERIVED_FLUSH_BYTES = 1024 * 1024; // 1 MiB streaming `putDerived` chunks

const BOOKKEEPING_MAGICS = new Set([
  'FLIS',
  'FCIS',
  'SRCS',
  'RESC',
  'BOUN',
  'CMET',
  'PAGE',
  'AUDI',
  'VIDE',
  'CRES',
  'CONT',
]);

/**
 * Decompresses all text records `[record0Index + 1 .. record0Index + header.textRecordCount]`
 * in coalesced `<= 1 MiB` ranged reads (NEVER 1 call per 4 KiB record!) and streams output
 * to `putDerived('text.bin', chunk)`. Also returns an in-memory `Uint8Array` for immediate
 * import-time indexing (`skel`/`frag` target scan or `<mbp:pagebreak>` scan).
 */
export async function decompressMobiTextStream(params: {
  readonly src: ByteSource;
  readonly recordOffsets: readonly number[];
  readonly fileSize: number;
  readonly record0Index: number;
  readonly header: ParsedMobiRecord0;
  readonly putDerived?: (name: string, chunk: Uint8Array) => Promise<void>;
}): Promise<Uint8Array> {
  const { src, recordOffsets, fileSize, record0Index, header, putDerived } = params;
  const count = header.textRecordCount;
  if (count === 0) {
    return new Uint8Array(0);
  }

  const firstRec = record0Index + 1;
  const lastRec = Math.min(recordOffsets.length - 1, record0Index + count);
  if (firstRec >= recordOffsets.length || lastRec < firstRec) {
    throw new MiniBookError('corrupt-book', 'MOBI text record indices exceed PDB record table');
  }

  let huffDecoder: HuffCdicDecoder | null = null;
  if (header.compression === 17480) {
    if (header.huffRecordIndex < 0 || header.huffRecordCount < 2) {
      throw new MiniBookError('corrupt-book', 'HUFF/CDIC book missing HUFF/CDIC record pointers');
    }
    const huffBase = record0Index + header.huffRecordIndex;
    const huffRec = await readPdbRecord(src, recordOffsets, fileSize, huffBase);
    const cdicRecs: Uint8Array[] = [];
    for (let c = 1; c < header.huffRecordCount; c++) {
      if (huffBase + c < recordOffsets.length) {
        cdicRecs.push(await readPdbRecord(src, recordOffsets, fileSize, huffBase + c));
      }
    }
    huffDecoder = new HuffCdicDecoder(huffRec, cdicRecs);
  }

  const outChunks: Uint8Array[] = [];
  let pendingFlush: Uint8Array[] = [];
  let pendingFlushBytes = 0;
  let totalDecompressed = 0;

  const flushDerived = async (force: boolean) => {
    if (!putDerived) return;
    if (pendingFlushBytes === 0) return;
    if (!force && pendingFlushBytes < DERIVED_FLUSH_BYTES) return;
    const combined = concatBytes(pendingFlush);
    pendingFlush = [];
    pendingFlushBytes = 0;
    await putDerived('text.bin', combined);
  };

  // Batch contiguous text records into <= 1 MiB ranged reads!
  let recIdx = firstRec;
  while (recIdx <= lastRec) {
    const batchStartRec = recIdx;
    const batchByteStart = getPdbRecordByteRange(recordOffsets, fileSize, batchStartRec).start;
    let batchEndRec = batchStartRec;
    let batchByteEnd = getPdbRecordByteRange(recordOffsets, fileSize, batchStartRec).end;

    while (batchEndRec + 1 <= lastRec) {
      const nextRange = getPdbRecordByteRange(recordOffsets, fileSize, batchEndRec + 1);
      if (nextRange.start < batchByteEnd) break;
      if (nextRange.end - batchByteStart > COALESCE_READ_BYTES) break;
      batchEndRec++;
      batchByteEnd = nextRange.end;
    }

    const batchBytes =
      batchByteEnd > batchByteStart
        ? await src.read(batchByteStart, batchByteEnd - batchByteStart)
        : new Uint8Array(0);

    for (let rIdx = batchStartRec; rIdx <= batchEndRec; rIdx++) {
      const range = getPdbRecordByteRange(recordOffsets, fileSize, rIdx);
      const localStart = range.start - batchByteStart;
      const localEnd = Math.min(batchBytes.byteLength, range.end - batchByteStart);
      if (localEnd <= localStart) continue;

      const rawRec = batchBytes.subarray(localStart, localEnd);
      const stripped = stripMobiTrailingEntries(rawRec, header.extraDataFlags);

      let decoded: Uint8Array;
      if (header.compression === 1) {
        decoded = stripped.slice();
      } else if (header.compression === 2) {
        decoded = decompressPalmDoc(stripped);
      } else {
        decoded = huffDecoder!.decompress(stripped);
      }

      totalDecompressed += decoded.byteLength;
      if (totalDecompressed > MAX_MOBI_TEXT_BYTES) {
        throw new MiniBookError(
          'too-large',
          `Decompressed MOBI text exceeds ${MAX_MOBI_TEXT_BYTES} bytes`,
        );
      }

      outChunks.push(decoded);
      if (putDerived) {
        pendingFlush.push(decoded);
        pendingFlushBytes += decoded.byteLength;
        if (pendingFlushBytes >= DERIVED_FLUSH_BYTES) {
          await flushDerived(true);
        }
      }
    }

    recIdx = batchEndRec + 1;
  }

  await flushDerived(true);

  const all = concatBytes(outChunks);
  if (header.textLength > 0 && all.byteLength > header.textLength) {
    return all.subarray(0, header.textLength);
  }
  return all;
}

export async function ensureTextBinSource(params: {
  readonly src: ByteSource;
  readonly getDerived?: (name: string) => ByteSource | null;
  readonly recordOffsets: readonly number[];
  readonly record0Index: number;
  readonly header?: ParsedMobiRecord0;
}): Promise<ByteSource> {
  const fromHost = params.getDerived?.('text.bin');
  if (fromHost) return fromHost;

  // Standalone fallback (e.g. direct `openBook(src, { fileName })` in unit tests without prior import)
  let header = params.header;
  if (!header) {
    const { parseMobiRecord0 } = await import('./pdb.js');
    const rec0 = await readPdbRecord(params.src, params.recordOffsets, params.src.size, params.record0Index);
    header = parseMobiRecord0(rec0, 'Book');
  }
  const full = await decompressMobiTextStream({
    src: params.src,
    recordOffsets: params.recordOffsets,
    fileSize: params.src.size,
    record0Index: params.record0Index,
    header,
  });
  return memoryByteSource(full);
}

/**
 * Loads an image or `FONT` resource record from a MOBI/KF8 container (`ARCHITECTURE.md` §4.4 #4).
 */
export async function loadMobiResourceRecord(
  src: ByteSource,
  recordOffsets: readonly number[],
  recordIndex: number,
  declaredMime?: string,
): Promise<BookResource> {
  if (recordIndex < 0 || recordIndex >= recordOffsets.length) {
    throw new MiniBookError('not-found', `MOBI resource record ${recordIndex} out of bounds`);
  }
  const bytes = await readPdbRecord(src, recordOffsets, src.size, recordIndex);
  if (bytes.byteLength === 0) {
    throw new MiniBookError('not-found', `MOBI resource record ${recordIndex} is empty`);
  }

  // EOF marker (`\xe9\x8e\r\n`) or 4-char bookkeeping magic
  if (bytes.byteLength === 4 && bytes[0] === 0xe9 && bytes[1] === 0x8e) {
    throw new MiniBookError('not-found', `MOBI EOF record at ${recordIndex}`);
  }
  if (bytes.byteLength >= 4) {
    const r = new BinaryReader(bytes);
    const magic4 = r.asciiAt(0, 4);
    if (BOOKKEEPING_MAGICS.has(magic4) || (bytes.byteLength >= 8 && r.asciiAt(0, 8) === 'BOUNDARY')) {
      throw new MiniBookError('not-found', `MOBI bookkeeping record "${magic4}" is not a media resource`);
    }

    // KF8 `FONT` record: optional XOR de-obfuscation (first 1040 bytes) + optional zlib inflate
    if (magic4 === 'FONT' && bytes.byteLength >= 24) {
      const flags = r.u32beAt(8);
      const dataOffset = r.u32beAt(12);
      const xorKeyLen = r.u32beAt(16);
      const xorKeyOff = r.u32beAt(20);
      if (dataOffset >= bytes.byteLength) {
        throw new MiniBookError('corrupt-book', 'FONT record dataOffset exceeds record length');
      }
      let fontPayload = bytes.slice(dataOffset);
      if ((flags & 0x02) !== 0 && xorKeyLen > 0 && xorKeyOff + xorKeyLen <= bytes.byteLength) {
        const key = bytes.subarray(xorKeyOff, xorKeyOff + xorKeyLen);
        const limit = Math.min(1040, fontPayload.byteLength);
        for (let i = 0; i < limit; i++) {
          fontPayload[i] = fontPayload[i]! ^ key[i % key.byteLength]!;
        }
      }
      if ((flags & 0x01) !== 0) {
        try {
          fontPayload = unzlibSync(fontPayload);
        } catch (err) {
          throw new MiniBookError('corrupt-book', `Failed to inflate KF8 FONT record: ${(err as Error).message}`, {
            cause: err,
          });
        }
      }
      return {
        bytes: fontPayload,
        mime: mimeFromMagic(fontPayload, declaredMime ?? 'font/ttf'),
      };
    }
  }

  return {
    bytes,
    mime: mimeFromMagic(bytes, declaredMime ?? 'image/jpeg'),
  };
}
