import { cleanTocHeading, scanSanitizedBody } from '../../book/heading.js';
import { sanitizeDocument } from '../../book/sanitize.js';
import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { concatBytes } from '../../io/binary.js';
import { parseXhtmlOrHtml } from '../../markup/html.js';
import { findFirst, localName, textContent } from '../../markup/mnode.js';
import type {
  BookMeta,
  BookOpenHint,
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  Kf8AnchorTarget,
  Kf8BookIndex,
  Kf8FragEntry,
  Kf8SectionIndex,
  ResolvedHref,
  SectionDoc,
  SectionRef,
  SectionText,
  TocItem,
} from '../../types.js';
import { decodeKindleBase32 } from '../../util/base32.js';
import { LruCache } from '../../util/lru.js';
import { parseFdstRecord, type ParsedIndxTable, readMobiIndxTable } from './indx.js';
import { type ParsedMobiRecord0, readPdbRecord } from './pdb.js';
import { ensureTextBinSource, loadMobiResourceRecord } from './resources.js';

const KINDLE_POS_REGEX = /kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)/g;
const KINDLE_POS_SINGLE = /^kindle:pos:fid:([0-9A-Za-z]+):off:([0-9A-Za-z]+)/i;
const KINDLE_FLOW_SINGLE = /^kindle:flow:([0-9A-Za-z]+)(?:\?.*)?$/i;
const KINDLE_EMBED_SINGLE = /^kindle:embed:([0-9A-Za-z]+)(?:\?(.*))?$/i;

/**
 * Assembles one KF8 XHTML file from raw UTF-8 flow-0 bytes BEFORE UTF-8 string decoding
 * (`ARCHITECTURE.md` §4.4 #2, `@code-critic` Audit Item #1):
 *
 *   base = skelLen (within `sectionFlowSlice` = `flow0[skelStart : skelStart + totalLen]`)
 *   out  = sectionFlowSlice[0 : skelLen]
 *   for frag in frags:
 *     slice = sectionFlowSlice[base : base + frag.length]
 *     rel   = frag.insertPos - skelStart
 *     out   = out[0 : rel] || slice || out[rel :]
 *     base += frag.length
 *
 * Operating strictly on raw `Uint8Array` bytes guarantees 3-byte CJK and 4-byte astral UTF-8
 * sequences NEVER shift or corrupt `rel`!
 */
export function assembleKf8SectionBytes(
  sectionFlowSlice: Uint8Array,
  skelStart: number,
  skelLen: number,
  frags: readonly Kf8FragEntry[],
  targets: readonly Kf8AnchorTarget[] = [],
): Uint8Array {
  if (skelLen < 0 || skelLen > sectionFlowSlice.byteLength) {
    throw new MiniBookError('corrupt-book', `KF8 skeleton length ${skelLen} exceeds flow slice ${sectionFlowSlice.byteLength}`);
  }

  let out = sectionFlowSlice.subarray(0, skelLen);
  let base = skelLen;

  for (let i = 0; i < frags.length; i++) {
    const frag = frags[i]!;
    const rel = frag.insertPos - skelStart;
    if (rel < 0 || rel > out.byteLength) {
      throw new MiniBookError(
        'corrupt-book',
        `KF8 fragment insertPos out of bounds: rel=${rel}, outLen=${out.byteLength}`,
      );
    }
    if (frag.length < 0 || base + frag.length > sectionFlowSlice.byteLength) {
      throw new MiniBookError(
        'corrupt-book',
        `KF8 fragment slice [${base}, ${base + frag.length}) exceeds section slice ${sectionFlowSlice.byteLength}`,
      );
    }
    const fragSlice = sectionFlowSlice.subarray(base, base + frag.length);
    out = concatBytes([out.subarray(0, rel), fragSlice, out.subarray(rel)]);
    base += frag.length;
  }

  if (targets.length === 0) {
    return out;
  }

  return injectAnchorsAtSafeUtf8TagBoundaries(out, skelStart, targets);
}

/**
 * Finds the byte index right after `<body...>` and right before `</body>` in raw UTF-8 XHTML bytes
 * so injected `<a id="..."/>` anchors always sit validly inside `<body>`.
 */
function findBodyByteBounds(utf8: Uint8Array): { readonly bodyStart: number; readonly bodyEnd: number } {
  const headAscii = new TextDecoder('utf-8', { fatal: false }).decode(
    utf8.subarray(0, Math.min(utf8.byteLength, 4096)),
  );
  let bodyStart = 0;
  const bodyOpenMatch = /<body\b[^>]*>/i.exec(headAscii);
  if (bodyOpenMatch) {
    // ASCII prefix byte length of `<body...>` match
    bodyStart = new TextEncoder().encode(headAscii.slice(0, bodyOpenMatch.index + bodyOpenMatch[0].length)).byteLength;
  }

  let bodyEnd = utf8.byteLength;
  const tailWindow = Math.min(utf8.byteLength, 1024);
  const tailOffset = utf8.byteLength - tailWindow;
  const tailAscii = new TextDecoder('utf-8', { fatal: false }).decode(utf8.subarray(tailOffset));
  const bodyCloseMatch = /<\/body\s*>/i.exec(tailAscii);
  if (bodyCloseMatch) {
    bodyEnd = tailOffset + new TextEncoder().encode(tailAscii.slice(0, bodyCloseMatch.index)).byteLength;
  }

  return { bodyStart, bodyEnd: Math.max(bodyStart, bodyEnd) };
}

/**
 * Snaps `rawLocalPos` in assembled UTF-8 bytes to a safe injection index:
 *   1. Clamped inside `[bodyStart, bodyEnd]`.
 *   2. Never inside a `<...>` tag (if scanning back hits `<` before `>`, advances past matching `>`).
 *   3. Never on a UTF-8 continuation byte (`(byte & 0xC0) === 0x80`).
 */
export function snapToSafeUtf8TagBoundary(
  utf8: Uint8Array,
  rawLocalPos: number,
  bodyStart: number,
  bodyEnd: number,
): number {
  let idx = Math.max(bodyStart, Math.min(bodyEnd, rawLocalPos));

  // Step 1: Never land on a UTF-8 continuation byte `10xxxxxx` (`0x80..0xBF`)
  while (idx < bodyEnd && (utf8[idx]! & 0xc0) === 0x80) {
    idx++;
  }

  // Step 2: Check if `idx` sits inside an open `<...>` markup tag
  let scanBack = idx - 1;
  let insideTag = false;
  while (scanBack >= bodyStart && idx - scanBack <= 2048) {
    const b = utf8[scanBack]!;
    if (b === 0x3e) {
      // `>` closed the previous tag before `idx`
      insideTag = false;
      break;
    }
    if (b === 0x3c) {
      // `<` opened a tag that has not closed yet at `idx`!
      insideTag = true;
      break;
    }
    scanBack--;
  }

  if (insideTag) {
    // Advance past the closing `>` of this tag
    let quote = 0;
    while (idx < bodyEnd) {
      const c = utf8[idx++]!;
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) {
        quote = c;
      } else if (c === 0x3e) {
        break;
      }
    }
    if (idx > bodyEnd) idx = bodyEnd;
  }

  // Final continuation check
  while (idx < bodyEnd && (utf8[idx]! & 0xc0) === 0x80) {
    idx++;
  }

  return idx;
}

function injectAnchorsAtSafeUtf8TagBoundaries(
  assembled: Uint8Array,
  skelStart: number,
  targets: readonly Kf8AnchorTarget[],
): Uint8Array {
  const { bodyStart, bodyEnd } = findBodyByteBounds(assembled);
  const enc = new TextEncoder();

  const resolved: Array<{ bytePos: number; id: string }> = [];
  const seenIds = new Set<string>();
  for (const t of targets) {
    if (seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    const localPos = t.pos - skelStart;
    const safePos = snapToSafeUtf8TagBoundary(assembled, localPos, bodyStart, bodyEnd);
    resolved.push({ bytePos: safePos, id: t.id });
  }

  resolved.sort((a, b) => a.bytePos - b.bytePos);

  // Single-pass non-perturbing concatenation over original `assembled` coordinates
  const pieces: Uint8Array[] = [];
  let cursor = 0;
  for (const item of resolved) {
    if (item.bytePos > cursor) {
      pieces.push(assembled.subarray(cursor, item.bytePos));
      cursor = item.bytePos;
    }
    pieces.push(enc.encode(`<a id="${item.id}"></a>`));
  }
  if (cursor < assembled.byteLength) {
    pieces.push(assembled.subarray(cursor));
  }
  return concatBytes(pieces);
}

function parseEmbedMimeParam(query: string | undefined): string | undefined {
  if (!query) return undefined;
  const m = /(?:^|&)mime=([^&]+)/i.exec(query);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function resolveKindleEmbedRecordOffset(rawUrl: string): { readonly zeroBasedIndex: number; readonly mime?: string } | null {
  const m = KINDLE_EMBED_SINGLE.exec(rawUrl.trim());
  if (!m?.[1]) return null;
  const n = decodeKindleBase32(m[1]);
  if (!Number.isFinite(n) || n < 1) return null;
  const mime = parseEmbedMimeParam(m[2]);
  return {
    zeroBasedIndex: n - 1,
    ...(mime ? { mime } : {}),
  };
}

function findSectionContainingFlowPos(sections: readonly Kf8SectionIndex[], pos: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sec = sections[mid]!;
    const secEnd = sec.skelStart + sec.totalLen;
    if (pos < sec.skelStart) {
      hi = mid - 1;
    } else if (pos >= secEnd) {
      lo = mid + 1;
    } else {
      return sec.index;
    }
  }
  // Clamp to last section if `pos === flow0End`
  if (sections.length > 0) {
    const last = sections[sections.length - 1]!;
    if (pos >= last.skelStart && pos <= last.skelStart + last.totalLen) {
      return last.index;
    }
  }
  return 0;
}

function buildKf8NcxToc(
  ncxTable: ParsedIndxTable,
  allFrags: readonly Kf8FragEntry[],
  sections: readonly Kf8SectionIndex[],
  registerPosTarget: (fid: number, off: number) => { section: number; id: string } | null,
): TocItem[] {
  interface RawTocNode {
    readonly idx: number;
    readonly title: string;
    readonly parentIdx: number;
    readonly locator: { section: number; offset: number };
    readonly href?: string;
    readonly children: TocItem[];
  }

  const nodes: RawTocNode[] = [];
  for (let i = 0; i < ncxTable.entries.length; i++) {
    const entry = ncxTable.entries[i]!;
    const labelOff = entry.tags[3]?.[0];
    const title = (ncxTable.getCncxString(labelOff) ?? entry.label).replace(/\s+/g, ' ').trim();
    if (!title) continue;

    const parentIdx = entry.tags[21]?.[0] ?? -1;
    let section = 0;
    let href: string | undefined;

    const posPair = entry.tags[6];
    if (posPair && posPair.length >= 2) {
      const fid = posPair[0]!;
      const off = posPair[1]!;
      const target = registerPosTarget(fid, off);
      if (target) {
        section = target.section;
        href = `${target.section}#${target.id}`;
      }
    } else if (entry.tags[1]?.[0] !== undefined) {
      const rawPos = entry.tags[1][0]!;
      section = findSectionContainingFlowPos(sections, rawPos);
      // Find frag row if possible
      let matchedFid = -1;
      for (let f = 0; f < allFrags.length; f++) {
        const fr = allFrags[f]!;
        if (rawPos >= fr.insertPos && rawPos <= fr.insertPos + fr.length) {
          matchedFid = f;
          break;
        }
      }
      if (matchedFid >= 0) {
        const off = rawPos - allFrags[matchedFid]!.insertPos;
        const target = registerPosTarget(matchedFid, off);
        if (target) href = `${target.section}#${target.id}`;
      }
    }

    nodes.push({
      idx: i,
      title,
      parentIdx,
      locator: { section, offset: 0 },
      ...(href ? { href } : {}),
      children: [],
    });
  }

  const byIdx = new Map<number, RawTocNode>();
  for (const n of nodes) byIdx.set(n.idx, n);

  const roots: TocItem[] = [];
  for (const n of nodes) {
    const item: TocItem = {
      title: n.title,
      locator: n.locator,
      ...(n.href ? { href: n.href } : {}),
      children: n.children,
    };
    const parent = n.parentIdx >= 0 ? byIdx.get(n.parentIdx) : undefined;
    if (parent && parent !== n) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }

  return roots;
}

export async function buildKf8IndexFromStream(params: {
  readonly src: ByteSource;
  readonly recordOffsets: readonly number[];
  readonly record0Index: number;
  readonly header: ParsedMobiRecord0;
  readonly textStream: Uint8Array;
}): Promise<Kf8BookIndex> {
  const { src, recordOffsets, record0Index, header, textStream } = params;
  const fileSize = src.size;

  if (header.skelIndex < 0 || header.fragIndex < 0) {
    throw new MiniBookError('corrupt-book', 'KF8 header missing skelIndex or fragIndex');
  }

  // 1. Parse `FDST` flow boundaries (`ARCHITECTURE.md` §4.4 #1)
  let flows: Array<{ readonly start: number; readonly end: number }> = [
    { start: 0, end: textStream.byteLength },
  ];
  if (header.fdstIndex >= 0 && record0Index + header.fdstIndex < recordOffsets.length) {
    const fdstRec = await readPdbRecord(src, recordOffsets, fileSize, record0Index + header.fdstIndex);
    flows = parseFdstRecord(fdstRec, textStream.byteLength);
  }
  const flow0 = flows[0] ?? { start: 0, end: textStream.byteLength };
  const flow0Bytes = textStream.subarray(flow0.start, flow0.end);

  // 2. Parse `skel` and `frag` INDX tables (self-verifying in case any encoder swapped offsets)
  let skelTable = await readMobiIndxTable(src, recordOffsets, fileSize, record0Index + header.skelIndex);
  let fragTable = await readMobiIndxTable(src, recordOffsets, fileSize, record0Index + header.fragIndex);

  if (
    skelTable.entries.length > 0 &&
    fragTable.entries.length > 0 &&
    !skelTable.entries[0]!.label.toUpperCase().startsWith('SKEL') &&
    fragTable.entries[0]!.label.toUpperCase().startsWith('SKEL')
  ) {
    const tmp = skelTable;
    skelTable = fragTable;
    fragTable = tmp;
  }

  if (skelTable.entries.length === 0) {
    throw new MiniBookError('corrupt-book', 'KF8 skeleton index contains zero entries');
  }

  // 3. Validate and pair skeletons with their contiguous fragment rows (`§4.4 #2`)
  const allFrags: Kf8FragEntry[] = [];
  let fragCursor = 0;
  const mutableSections: Array<{
    index: number;
    name: string;
    skelStart: number;
    skelLen: number;
    totalLen: number;
    frags: Kf8FragEntry[];
    linear: boolean;
    targets: Kf8AnchorTarget[];
  }> = [];

  for (let sIdx = 0; sIdx < skelTable.entries.length; sIdx++) {
    const skelEntry = skelTable.entries[sIdx]!;
    const fragCount = skelEntry.tags[1]?.[0] ?? 0;
    const posLen = skelEntry.tags[6];
    if (!posLen || posLen.length < 2) {
      throw new MiniBookError('corrupt-book', `KF8 skeleton ${sIdx} missing tag 6 [skelStart, skelLen]`);
    }
    const skelStart = posLen[0]!;
    const skelLen = posLen[1]!;

    if (fragCursor + fragCount > fragTable.entries.length) {
      throw new MiniBookError(
        'corrupt-book',
        `KF8 skeleton ${sIdx} requests ${fragCount} fragments at ${fragCursor}, exceeding ${fragTable.entries.length}`,
      );
    }

    const secFrags: Kf8FragEntry[] = [];
    let sumFragLen = 0;
    let simulatedOutLen = skelLen;

    for (let f = 0; f < fragCount; f++) {
      const fEntry = fragTable.entries[fragCursor + f]!;
      const insertPos = Number.parseInt(fEntry.label, 10);
      const fPosLen = fEntry.tags[6];
      const length = fPosLen && fPosLen.length >= 2 ? fPosLen[1]! : (fPosLen?.[0] ?? 0);
      const selectorOff = fEntry.tags[2]?.[0];
      const selector = fragTable.getCncxString(selectorOff);

      if (!Number.isFinite(insertPos)) {
        throw new MiniBookError('corrupt-book', `KF8 fragment ${fragCursor + f} has non-numeric insertPos "${fEntry.label}"`);
      }
      const rel = insertPos - skelStart;
      if (rel < 0 || rel > simulatedOutLen) {
        throw new MiniBookError(
          'corrupt-book',
          `KF8 sanity check failed on section ${sIdx}: rel=${rel} outside [0, ${simulatedOutLen}]`,
        );
      }

      const fragObj: Kf8FragEntry = {
        insertPos,
        length,
        ...(selector ? { selector } : {}),
      };
      secFrags.push(fragObj);
      allFrags.push(fragObj);
      sumFragLen += length;
      simulatedOutLen += length;
    }

    const totalLen = skelLen + sumFragLen;
    if (skelStart < 0 || skelStart + totalLen > flow0Bytes.byteLength) {
      throw new MiniBookError(
        'corrupt-book',
        `KF8 section ${sIdx} range [${skelStart}, ${skelStart + totalLen}) exceeds flow 0 (${flow0Bytes.byteLength})`,
      );
    }

    fragCursor += fragCount;
    mutableSections.push({
      index: sIdx,
      name: skelEntry.label,
      skelStart,
      skelLen,
      totalLen,
      frags: secFrags,
      linear: true,
      targets: [],
    });
  }

  if (fragCursor !== fragTable.entries.length) {
    throw new MiniBookError(
      'corrupt-book',
      `KF8 sum(fragCount)=${fragCursor} does not equal frag table length ${fragTable.entries.length}`,
    );
  }

  // 4. Scan flow 0 + NCX + Guide for all `kindle:pos:fid:XXXX:off:YYYYYYYYYY` link targets (`§4.4 #3`)
  const posMap: Record<string, { section: number; id: string }> = {};

  const registerPosTarget = (fid: number, off: number): { section: number; id: string } | null => {
    if (fid < 0 || fid >= allFrags.length || off < 0) return null;
    const key = `${fid}:${off}`;
    const existing = posMap[key];
    if (existing) return existing;

    const absPos = allFrags[fid]!.insertPos + off;
    const secIdx = findSectionContainingFlowPos(mutableSections, absPos);
    const id = `mb-pos-${fid}-${off}`;
    mutableSections[secIdx]!.targets.push({ id, pos: absPos });
    const entry = { section: secIdx, id };
    posMap[key] = entry;
    return entry;
  };

  const flow0TextForScan = new TextDecoder('utf-8', { fatal: false }).decode(flow0Bytes);
  KINDLE_POS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KINDLE_POS_REGEX.exec(flow0TextForScan)) !== null) {
    const fid = decodeKindleBase32(match[1]!);
    const off = decodeKindleBase32(match[2]!);
    if (Number.isFinite(fid) && Number.isFinite(off)) {
      registerPosTarget(fid, off);
    }
  }

  // 5. Parse NCX & Guide INDX tables (`§4.4 #5`)
  let toc: TocItem[] = [];
  if (header.ncxIndex >= 0 && record0Index + header.ncxIndex < recordOffsets.length) {
    try {
      const ncxTable = await readMobiIndxTable(src, recordOffsets, fileSize, record0Index + header.ncxIndex);
      toc = buildKf8NcxToc(ncxTable, allFrags, mutableSections, registerPosTarget);
    } catch {
      toc = [];
    }
  }

  const guideItems: Array<{ type: string; title: string; posFid?: number; posOff?: number }> = [];
  if (header.guideIndex >= 0 && record0Index + header.guideIndex < recordOffsets.length) {
    try {
      const guideTable = await readMobiIndxTable(src, recordOffsets, fileSize, record0Index + header.guideIndex);
      for (const g of guideTable.entries) {
        const gTitle = guideTable.getCncxString(g.tags[1]?.[0]) ?? g.label;
        const posPair = g.tags[6];
        const posFid = posPair?.[0];
        const posOff = posPair?.[1] ?? 0;
        if (posFid !== undefined) registerPosTarget(posFid, posOff);
        guideItems.push({
          type: g.label,
          title: gTitle,
          ...(posFid !== undefined ? { posFid, posOff } : {}),
        });
      }
    } catch {
      // Optional guide
    }
  }

  for (const sec of mutableSections) {
    sec.targets.sort((a, b) => a.pos - b.pos);
  }

  const spine: SectionRef[] = mutableSections.map((sec) => ({
    index: sec.index,
    id: sec.name,
    linear: sec.linear,
    sizeHint: Math.max(64, Math.floor(sec.totalLen * 0.65)),
  }));

  // Helper to scan a KF8 section in memory (`flow0Bytes` is already loaded -> 0 extra I/O reads!)
  // for exact `countedChars` (`[P1-F1]`), anchor char offsets (`[P1-C2]`), and heading-derived TOC (`[P2]`).
  const scannedKf8Sections = new Map<
    number,
    { anchors: Map<string, number>; heading: string | null; countedChars: number }
  >();
  const scanKf8SectionInMemory = async (secIdx: number) => {
    const cached = scannedKf8Sections.get(secIdx);
    if (cached) return cached;
    const sec = mutableSections[secIdx];
    if (!sec) return null;
    try {
      const slice = flow0Bytes.subarray(sec.skelStart, sec.skelStart + sec.totalLen);
      const assembled = assembleKf8SectionBytes(slice, sec.skelStart, sec.skelLen, sec.frags, sec.targets);
      const xhtml = new TextDecoder('utf-8', { fatal: false }).decode(assembled);
      const tree = parseXhtmlOrHtml(xhtml, false);
      const headTitleEl = findFirst(tree, (n) => localName(n.tag).toLowerCase() === 'title');
      const rawHeadTitle = headTitleEl ? textContent(headTitleEl) : '';
      const sanitized = await sanitizeDocument(tree, {
        sectionPath: `${sec.name}.xhtml`,
        defaultLang: header.exth.language ?? header.localeLang,
        defaultDir: header.exth.direction ?? 'ltr',
      });
      const bodyInfo = scanSanitizedBody(sanitized.bodyChildren, rawHeadTitle, header.title);
      const entry = {
        anchors: bodyInfo.anchors,
        heading: bodyInfo.heading,
        countedChars: bodyInfo.countedChars,
      };
      scannedKf8Sections.set(secIdx, entry);
      return entry;
    } catch {
      return null;
    }
  };

  // Scan all sections in memory (`0` extra reads!) so `SectionRef.charLength` & `sizeHint` are exact counted chars (`[P1-F1]`)!
  for (let idx = 0; idx < mutableSections.length; idx++) {
    const scanned = await scanKf8SectionInMemory(idx);
    if (scanned) {
      spine[idx] = {
        ...spine[idx]!,
        sizeHint: Math.max(1, scanned.countedChars),
        charLength: scanned.countedChars,
      };
    }
  }

  // Sparse TOC fallback (`[P2]`: e.g. Gutenberg zh KF8 with 1 license entry for 13 chapters)
  const collectKf8TocSections = (items: readonly TocItem[], acc = new Set<number>()): Set<number> => {
    for (const it of items) {
      acc.add(it.locator.section);
      if (it.children.length > 0) collectKf8TocSections(it.children, acc);
    }
    return acc;
  };
  const coveredKf8 = collectKf8TocSections(toc);
  if (toc.length === 0 || (spine.length >= 2 && coveredKf8.size < spine.length * 0.5)) {
    const bySec = new Map<number, TocItem[]>();
    for (const item of toc) {
      const list = bySec.get(item.locator.section) ?? [];
      list.push(item);
      bySec.set(item.locator.section, list);
    }
    const rebuilt: TocItem[] = [];
    for (let idx = 0; idx < spine.length; idx++) {
      const s = spine[idx]!;
      const existing = bySec.get(s.index);
      if (existing && existing.length > 0) {
        rebuilt.push(
          ...existing.map((it) => ({
            ...it,
            title: cleanTocHeading(it.title) ?? it.title,
          })),
        );
        continue;
      }
      const scanned = await scanKf8SectionInMemory(s.index);
      if (scanned && scanned.countedChars === 0 && !scanned.heading && spine.length > 1) {
        continue;
      }
      const heading = scanned?.heading || `Section ${idx + 1}`;
      spine[s.index] = { ...spine[s.index]!, title: heading };
      rebuilt.push({
        title: heading,
        locator: { section: s.index, offset: 0 },
        children: [],
      });
    }
    if (rebuilt.length > 0) toc = rebuilt;
  }

  // Resolve exact `#mb-pos-...` offsets for TOC items & `posMap` (`[P1-C2]`)
  const sectionsWithTargets = new Set<number>();
  for (const sec of mutableSections) {
    if (sec.targets.length > 0) sectionsWithTargets.add(sec.index);
  }
  for (const secIdx of sectionsWithTargets) {
    await scanKf8SectionInMemory(secIdx);
  }

  const posMapWithOffsets: Record<string, { section: number; id: string; approxOffset?: number }> = {};
  for (const [k, v] of Object.entries(posMap)) {
    const exactOff = scannedKf8Sections.get(v.section)?.anchors.get(v.id);
    posMapWithOffsets[k] = exactOff !== undefined ? { ...v, approxOffset: exactOff } : v;
  }

  const applyKf8TocOffsets = (items: readonly TocItem[]): TocItem[] =>
    items.map((it) => {
      const children = it.children.length > 0 ? applyKf8TocOffsets(it.children) : [];
      let locator = it.locator;
      if (it.href) {
        const hashIdx = it.href.indexOf('#');
        if (hashIdx >= 0) {
          const frag = it.href.slice(hashIdx + 1);
          const off = scannedKf8Sections.get(it.locator.section)?.anchors.get(frag);
          if (off !== undefined) locator = { section: it.locator.section, offset: off };
        }
      }
      return { ...it, locator, children };
    });
  toc = applyKf8TocOffsets(toc);

  const assignTitles = (items: readonly TocItem[]) => {
    for (const item of items) {
      const sp = spine[item.locator.section];
      if (sp && !sp.title) {
        spine[item.locator.section] = { ...sp, title: item.title };
      }
      if (item.children.length > 0) assignTitles(item.children);
    }
  };
  assignTitles(toc);

  // Cover record resolution: EXTH 129 (`kindle:embed:XXXX`) -> EXTH 201 (`coverOffset`) -> null
  let coverRecordIndex: number | null = null;
  const firstImageGlobal =
    header.firstImageIndex >= 0 ? record0Index + header.firstImageIndex : -1;
  if (header.exth.kf8CoverUri && firstImageGlobal >= 0) {
    const embed = resolveKindleEmbedRecordOffset(header.exth.kf8CoverUri);
    if (embed && firstImageGlobal + embed.zeroBasedIndex < recordOffsets.length) {
      coverRecordIndex = firstImageGlobal + embed.zeroBasedIndex;
    }
  }
  if (coverRecordIndex === null && header.exth.coverOffset !== undefined && firstImageGlobal >= 0) {
    const cand = firstImageGlobal + header.exth.coverOffset;
    if (cand < recordOffsets.length) coverRecordIndex = cand;
  }

  const meta: BookMeta = {
    title: header.title,
    authors: header.exth.authors,
    language: header.exth.language ?? header.localeLang,
    identifier: header.exth.identifier ?? (header.uid ? String(header.uid) : null),
    format: 'kf8',
    direction: header.exth.direction ?? 'ltr',
    fixedLayout: false,
    ...(header.exth.description ? { description: header.exth.description } : {}),
    ...(header.exth.publisher ? { publisher: header.exth.publisher } : {}),
    ...(header.exth.publishedAt ? { publishedAt: header.exth.publishedAt } : {}),
  };

  return {
    kind: 'kf8',
    meta,
    toc,
    spine,
    pdbRecordOffsets: recordOffsets,
    record0Index,
    firstImageRecord: firstImageGlobal,
    flows,
    sections: mutableSections,
    posMap: posMapWithOffsets,
    coverRecordIndex,
    ...(guideItems.length > 0 ? { guide: guideItems } : {}),
  };
}

export async function createKf8Session(
  src: ByteSource,
  hint: BookOpenHint,
  index: Kf8BookIndex,
): Promise<BookSession> {
  const textBin = await ensureTextBinSource({
    src,
    ...(hint.getDerived ? { getDerived: hint.getDerived } : {}),
    recordOffsets: index.pdbRecordOffsets,
    record0Index: index.record0Index,
  });

  const flowCssCache = new LruCache<number, string>(16);
  const sectionCache = new LruCache<number, BuiltSectionUnits>(4);
  const anchorOffsets = new Map<number, ReadonlyMap<string, number>>();
  const embedMimeHints = new Map<string, string>();

  const resolveKf8ResourceUrl = (
    rawUrl: string,
  ): { placeholder: string; resourcePath?: string } | null => {
    const trimmed = rawUrl.trim();
    const embed = resolveKindleEmbedRecordOffset(trimmed);
    if (embed) {
      const canonicalKey = `kindle:embed:${embed.zeroBasedIndex}`;
      if (embed.mime) embedMimeHints.set(canonicalKey, embed.mime);
      return {
        placeholder: `mb-res:${canonicalKey}`,
        resourcePath: canonicalKey,
      };
    }
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,/i.test(trimmed)) {
      return { placeholder: trimmed };
    }
    return null;
  };

  const loadFlowStylesheet = async (flowRef: string): Promise<string | null> => {
    const m = KINDLE_FLOW_SINGLE.exec(flowRef.trim()) ?? /^flow-(\d+)\.css$/i.exec(flowRef.trim());
    if (!m?.[1]) return null;
    const flowIdx = flowRef.toLowerCase().startsWith('kindle:flow:')
      ? decodeKindleBase32(m[1])
      : Number.parseInt(m[1], 10);
    if (!Number.isFinite(flowIdx) || flowIdx < 1 || flowIdx >= index.flows.length) {
      return null;
    }
    const cached = flowCssCache.get(flowIdx);
    if (cached !== undefined) return cached;

    const flowRange = index.flows[flowIdx]!;
    const rawBytes = await textBin.read(flowRange.start, flowRange.end - flowRange.start);
    const cssText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes);
    flowCssCache.set(flowIdx, cssText);
    return cssText;
  };

  const loadUnits = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const hit = sectionCache.get(sectionIndex);
    if (hit) return hit;

    const secInfo = index.sections[sectionIndex];
    if (!secInfo) {
      throw new MiniBookError('not-found', `KF8 section ${sectionIndex} out of range`);
    }

    const flow0Origin = index.flows[0]?.start ?? 0;
    // ONE contiguous ranged read of `text.bin` per section (`ARCHITECTURE.md` §4.4 #2)!
    const sectionFlowSlice = await textBin.read(
      flow0Origin + secInfo.skelStart,
      secInfo.totalLen,
    );

    const assembledBytes = assembleKf8SectionBytes(
      sectionFlowSlice,
      secInfo.skelStart,
      secInfo.skelLen,
      secInfo.frags,
      secInfo.targets,
    );

    let xhtmlString = new TextDecoder('utf-8', { fatal: false }).decode(assembledBytes);
    // Rewrite `<link href="kindle:flow:0001?mime=text/css">` to local pseudo-path `flow-1.css` so `sanitizeDocument` loads it via `loadSheet`
    xhtmlString = xhtmlString.replace(
      /(<link\b[^>]*?\bhref\s*=\s*["'])kindle:flow:([0-9A-Za-z]+)(?:\?[^"']*)?(["'])/gi,
      (_m, pre: string, b32: string, post: string) => {
        const flowNum = decodeKindleBase32(b32);
        return Number.isFinite(flowNum) ? `${pre}flow-${flowNum}.css${post}` : `${pre}${post}`;
      },
    );

    const parsedDoc = parseXhtmlOrHtml(xhtmlString, false);

    const sanitized = await sanitizeDocument(parsedDoc, {
      sectionPath: `${secInfo.name}.xhtml`,
      defaultLang: index.meta.language,
      defaultDir: index.meta.direction,
      loadSheet: async (sheetPath) => {
        const rawCss = await loadFlowStylesheet(sheetPath);
        if (!rawCss) return null;
        // Rewrite `@import "kindle:flow:XXXX"` inside KF8 CSS flows so `sanitizeStylesheet` resolves nested flows cleanly
        return rawCss.replace(
          /kindle:flow:([0-9A-Za-z]+)(?:\?[^"')\s]*)?/gi,
          (_m, b32: string) => `flow-${decodeKindleBase32(b32)}.css`,
        );
      },
      resolveResourceUrl: (u) => resolveKf8ResourceUrl(u),
      resolveLinkHref: (rawHref) => {
        const trimmed = rawHref.trim();
        if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
        const posMatch = KINDLE_POS_SINGLE.exec(trimmed);
        if (posMatch) {
          const fid = decodeKindleBase32(posMatch[1]!);
          const off = decodeKindleBase32(posMatch[2]!);
          const target = index.posMap[`${fid}:${off}`];
          if (target) return { loc: `${target.section}#${target.id}` };
          return null;
        }
        if (trimmed.startsWith('#')) {
          return { loc: `${sectionIndex}${trimmed}` };
        }
        return null;
      },
    });

    const idMap = new Map<string, number>();
    let cursor = 0;
    const walkIds = (nodes: typeof sanitized.bodyChildren) => {
      for (const n of nodes) {
        if (n.type === 'text') {
          cursor += n.value.length;
          continue;
        }
        const idVal = n.attrs['id'];
        if (idVal && !idMap.has(idVal)) idMap.set(idVal, cursor);
        if ('data-mb-skip' in n.attrs) continue;
        walkIds(n.children);
      }
    };
    walkIds(sanitized.bodyChildren);
    anchorOffsets.set(sectionIndex, idMap);

    const built = buildSectionRenderUnits({
      sectionIndex,
      bodyChildren: sanitized.bodyChildren,
      css: sanitized.css,
      lang: sanitized.lang,
      dir: sanitized.dir,
      resources: sanitized.resources,
      isCoverLike: sanitized.isCoverLike,
    });
    sectionCache.set(sectionIndex, built);
    return built;
  };

  return {
    meta: index.meta,
    toc: index.toc as TocItem[],
    spine: index.spine,

    async loadSection(sectionIndex: number, unitIndex = 0): Promise<SectionDoc> {
      const built = await loadUnits(sectionIndex);
      const clamped = Math.max(0, Math.min(built.units.length - 1, unitIndex));
      return built.units[clamped]!;
    },

    async loadSectionUnits(sectionIndex: number): Promise<readonly SectionDoc[]> {
      return (await loadUnits(sectionIndex)).units;
    },

    async loadSectionText(sectionIndex: number): Promise<SectionText> {
      return (await loadUnits(sectionIndex)).fullText;
    },

    async loadResource(href: string): Promise<BookResource> {
      if (index.firstImageRecord < 0) {
        throw new MiniBookError('not-found', `KF8 book has no image/font records for "${href}"`);
      }
      if (href.startsWith('kindle:embed:')) {
        const tail = href.slice('kindle:embed:'.length);
        // Either our normalized decimal zero-based key or raw base-32 `XXXX`
        const num = /^\d+$/.test(tail) ? Number.parseInt(tail, 10) : decodeKindleBase32(tail) - 1;
        if (!Number.isFinite(num) || num < 0) {
          throw new MiniBookError('not-found', `Invalid kindle:embed reference "${href}"`);
        }
        return loadMobiResourceRecord(
          src,
          index.pdbRecordOffsets,
          index.firstImageRecord + num,
          embedMimeHints.get(href),
        );
      }
      throw new MiniBookError('not-found', `Unknown KF8 resource "${href}"`);
    },

    resolveHref(fromSection: number, href: string): ResolvedHref {
      const trimmed = href.trim();
      if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };

      const posMatch = KINDLE_POS_SINGLE.exec(trimmed);
      if (posMatch) {
        const fid = decodeKindleBase32(posMatch[1]!);
        const off = decodeKindleBase32(posMatch[2]!);
        const target = index.posMap[`${fid}:${off}`];
        if (!target) return null;
        const charOff = anchorOffsets.get(target.section)?.get(target.id) ?? target.approxOffset ?? 0;
        return { section: target.section, offset: charOff };
      }

      const mbLoc = /^(\d+)(?::(\d+)|#(.+))?$/.exec(trimmed);
      if (mbLoc) {
        const sec = Number.parseInt(mbLoc[1]!, 10);
        if (sec < 0 || sec >= index.spine.length) return null;
        if (mbLoc[2] !== undefined) return { section: sec, offset: Number.parseInt(mbLoc[2], 10) };
        const frag = mbLoc[3];
        let off = frag ? anchorOffsets.get(sec)?.get(frag) : 0;
        if (off === undefined && frag) {
          const mPos = /^mb-pos-(\d+)-(\d+)$/.exec(frag);
          if (mPos) off = index.posMap[`${mPos[1]}:${mPos[2]}`]?.approxOffset;
        }
        return { section: sec, offset: off ?? 0 };
      }

      if (trimmed.startsWith('#')) {
        const frag = trimmed.slice(1);
        const off = anchorOffsets.get(fromSection)?.get(frag) ?? 0;
        return { section: fromSection, offset: off };
      }

      return null;
    },

    async cover(): Promise<CoverImage | null> {
      if (index.coverRecordIndex === null) return null;
      try {
        return await loadMobiResourceRecord(src, index.pdbRecordOffsets, index.coverRecordIndex);
      } catch {
        return null;
      }
    },

    close(): void {
      flowCssCache.clear();
      sectionCache.clear();
      anchorOffsets.clear();
    },
  };
}
