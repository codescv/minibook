import { memoryByteSource } from '../../io/ByteSource.js';
import { BinaryReader } from '../../io/binary.js';
import type {
  BookInspectHint,
  BookOpenHint,
  BookSession,
  ByteSource,
  CoverImage,
  InspectedBook,
  Kf8BookIndex,
  Mobi6BookIndex,
  TxtBookIndex,
} from '../../types.js';
import { inspectTxt, openTxtSession } from '../txt/txt.js';
import { buildKf8IndexFromStream, createKf8Session } from './kf8.js';
import { buildMobi6IndexFromStream, createMobi6Session } from './mobi6.js';
import { parseMobiRecord0, readPdbContainer, readPdbRecord } from './pdb.js';
import { decompressMobiTextStream, loadMobiResourceRecord } from './resources.js';

/**
 * Resolves the KF8 Record 0 index inside a combo MOBI 7 + KF8 file (`EXTH 121`):
 *   - If `pdbRecord[boundary]` is `'BOUNDARY'`, KF8 Record 0 is `boundary + 1`.
 *   - If `pdbRecord[boundary]` already carries `'MOBI'` at offset 16, KF8 Record 0 is `boundary`.
 */
async function resolveComboKf8Record0Index(
  src: ByteSource,
  recordOffsets: readonly number[],
  boundaryIndex: number,
): Promise<number | null> {
  if (boundaryIndex <= 0 || boundaryIndex >= recordOffsets.length) return null;
  const rec = await readPdbRecord(src, recordOffsets, src.size, boundaryIndex);
  if (rec.byteLength >= 8) {
    const r = new BinaryReader(rec);
    if (r.asciiAt(0, 8) === 'BOUNDARY') {
      return boundaryIndex + 1 < recordOffsets.length ? boundaryIndex + 1 : null;
    }
    if (rec.byteLength >= 20 && r.asciiAt(16, 4) === 'MOBI') {
      return boundaryIndex;
    }
  }
  return boundaryIndex + 1 < recordOffsets.length ? boundaryIndex + 1 : null;
}

export async function inspectPalmDocTxt(
  src: ByteSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  const pdb = await readPdbContainer(src);
  const rec0Bytes = await readPdbRecord(src, pdb.recordOffsets, pdb.fileSize, 0);
  const header = parseMobiRecord0(rec0Bytes, pdb.name);
  const textStream = await decompressMobiTextStream({
    src,
    recordOffsets: pdb.recordOffsets,
    fileSize: pdb.fileSize,
    record0Index: 0,
    header,
    ...(hint.putDerived ? { putDerived: hint.putDerived } : {}),
  });
  const txtResult = await inspectTxt(memoryByteSource(textStream), {
    fileName: hint.fileName,
  });
  const txtIndex: TxtBookIndex = {
    ...(txtResult.index as TxtBookIndex),
    usesDerivedText: true,
    meta: {
      ...txtResult.meta,
      title: pdb.name || txtResult.meta.title,
    },
  };
  return {
    meta: txtIndex.meta,
    cover: null,
    index: txtIndex,
  };
}

export async function openPalmDocTxtSession(
  src: ByteSource,
  hint: BookOpenHint,
  preloadedIndex?: TxtBookIndex,
): Promise<BookSession> {
  const derived = hint.getDerived?.('text.bin');
  if (derived && preloadedIndex) {
    return openTxtSession(derived, hint, { ...preloadedIndex, usesDerivedText: false });
  }
  const pdb = await readPdbContainer(src);
  const rec0Bytes = await readPdbRecord(src, pdb.recordOffsets, pdb.fileSize, 0);
  const header = parseMobiRecord0(rec0Bytes, pdb.name);
  const textStream = await decompressMobiTextStream({
    src,
    recordOffsets: pdb.recordOffsets,
    fileSize: pdb.fileSize,
    record0Index: 0,
    header,
  });
  return openTxtSession(
    memoryByteSource(textStream),
    hint,
    preloadedIndex ? { ...preloadedIndex, usesDerivedText: false } : undefined,
  );
}

/**
 * Inspects a `.mobi` / `.azw3` (KF8-only, MOBI 6, or Combo MOBI 7 + KF8) container (`§4.4`).
 * In a combo file, prefers the KF8 half and falls back cleanly to the MOBI 6 half if KF8 assembly fails!
 */
export async function inspectMobiOrKf8(
  src: ByteSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  const pdb = await readPdbContainer(src);
  const rec0Bytes = await readPdbRecord(src, pdb.recordOffsets, pdb.fileSize, 0);
  const primaryHeader = parseMobiRecord0(rec0Bytes, pdb.name);

  // Case 1: Pure KF8 (`fileVersion >= 8` at Record 0)
  if (primaryHeader.fileVersion >= 8) {
    const textStream = await decompressMobiTextStream({
      src,
      recordOffsets: pdb.recordOffsets,
      fileSize: pdb.fileSize,
      record0Index: 0,
      header: primaryHeader,
      ...(hint.putDerived ? { putDerived: hint.putDerived } : {}),
    });
    const index = await buildKf8IndexFromStream({
      src,
      recordOffsets: pdb.recordOffsets,
      record0Index: 0,
      header: primaryHeader,
      textStream,
    });
    const cover = await tryLoadCover(src, pdb.recordOffsets, index.coverRecordIndex);
    return { meta: index.meta, cover, index };
  }

  // Case 2: Combo MOBI 7 + KF8 (`EXTH 121` boundary present on Record 0)
  if (primaryHeader.exth.kf8BoundaryRecord !== undefined) {
    const kf8Rec0Idx = await resolveComboKf8Record0Index(
      src,
      pdb.recordOffsets,
      primaryHeader.exth.kf8BoundaryRecord,
    );
    if (kf8Rec0Idx !== null) {
      try {
        const kf8Rec0Bytes = await readPdbRecord(src, pdb.recordOffsets, pdb.fileSize, kf8Rec0Idx);
        const kf8Header = parseMobiRecord0(kf8Rec0Bytes, primaryHeader.title);
        // Combo files share images stored in the first half (`primaryHeader.firstImageIndex`) when KF8's own `firstImageIndex` is unset or relative!
        const sharedFirstImageGlobal =
          primaryHeader.firstImageIndex >= 0 ? primaryHeader.firstImageIndex : -1;

        const kf8Chunks: Uint8Array[] = [];
        const textStream = await decompressMobiTextStream({
          src,
          recordOffsets: pdb.recordOffsets,
          fileSize: pdb.fileSize,
          record0Index: kf8Rec0Idx,
          header: kf8Header,
          putDerived: async (_name, chunk) => {
            kf8Chunks.push(chunk);
          },
        });
        let index = await buildKf8IndexFromStream({
          src,
          recordOffsets: pdb.recordOffsets,
          record0Index: kf8Rec0Idx,
          header: kf8Header,
          textStream,
        });

        // If combo images live in the MOBI 6 half (`record 0` section), adopt `sharedFirstImageGlobal`
        if (
          sharedFirstImageGlobal >= 0 &&
          (index.firstImageRecord < 0 || index.firstImageRecord >= pdb.recordOffsets.length)
        ) {
          const coverOffset = kf8Header.exth.coverOffset ?? primaryHeader.exth.coverOffset;
          index = {
            ...index,
            firstImageRecord: sharedFirstImageGlobal,
            coverRecordIndex:
              coverOffset !== undefined && sharedFirstImageGlobal + coverOffset < pdb.recordOffsets.length
                ? sharedFirstImageGlobal + coverOffset
                : index.coverRecordIndex,
          };
        }

        if (hint.putDerived) {
          for (const ch of kf8Chunks) {
            await hint.putDerived('text.bin', ch);
          }
        }
        const cover = await tryLoadCover(src, pdb.recordOffsets, index.coverRecordIndex);
        return { meta: index.meta, cover, index };
      } catch (err) {
        // Re-throw DRM or size-limit errors; fall back to MOBI 6 half on `corrupt-book` (`§4.4`)
        if (err && typeof err === 'object' && 'code' in err) {
          const code = (err as { code: string }).code;
          if (code === 'drm-protected' || code === 'too-large') throw err;
        }
      }
    }
  }

  // Case 3: MOBI 6 (or Combo fallback!)
  const textStream = await decompressMobiTextStream({
    src,
    recordOffsets: pdb.recordOffsets,
    fileSize: pdb.fileSize,
    record0Index: 0,
    header: primaryHeader,
    ...(hint.putDerived ? { putDerived: hint.putDerived } : {}),
  });
  const index = await buildMobi6IndexFromStream({
    src,
    recordOffsets: pdb.recordOffsets,
    record0Index: 0,
    header: primaryHeader,
    textStream,
  });
  const cover = await tryLoadCover(src, pdb.recordOffsets, index.coverRecordIndex);
  return { meta: index.meta, cover, index };
}

export async function openMobiOrKf8Session(
  src: ByteSource,
  hint: BookOpenHint,
  preloadedIndex?: Kf8BookIndex | Mobi6BookIndex,
): Promise<BookSession> {
  if (preloadedIndex) {
    if (preloadedIndex.kind === 'kf8') {
      return createKf8Session(src, hint, preloadedIndex);
    }
    return createMobi6Session(src, hint, preloadedIndex);
  }

  // Standalone open without prior `inspectBook`: build index + in-memory `text.bin` source
  const derivedChunks: Uint8Array[] = [];
  const inspected = await inspectMobiOrKf8(src, {
    fileName: hint.fileName,
    putDerived: async (_name, chunk) => {
      derivedChunks.push(chunk);
    },
  });
  const { concatBytes } = await import('../../io/binary.js');
  const memTextBin = memoryByteSource(concatBytes(derivedChunks));
  const augmentedHint: BookOpenHint = {
    ...hint,
    getDerived: (name) => hint.getDerived?.(name) ?? (name === 'text.bin' ? memTextBin : null),
  };

  if (inspected.index.kind === 'kf8') {
    return createKf8Session(src, augmentedHint, inspected.index);
  }
  return createMobi6Session(src, augmentedHint, inspected.index as Mobi6BookIndex);
}

async function tryLoadCover(
  src: ByteSource,
  recordOffsets: readonly number[],
  coverRecordIndex: number | null,
): Promise<CoverImage | null> {
  if (coverRecordIndex === null) return null;
  try {
    return await loadMobiResourceRecord(src, recordOffsets, coverRecordIndex);
  } catch {
    return null;
  }
}
