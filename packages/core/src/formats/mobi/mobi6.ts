import { sanitizeDocument } from '../../book/sanitize.js';
import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { concatBytes } from '../../io/binary.js';
import { decodeBytesWithEncoding } from '../../io/encoding.js';
import { parseHtmlDocument } from '../../markup/html.js';
import type {
  BookMeta,
  BookOpenHint,
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  Mobi6BookIndex,
  Mobi6SectionIndex,
  ResolvedHref,
  SectionDoc,
  SectionRef,
  SectionText,
  TocItem,
} from '../../types.js';
import { LruCache } from '../../util/lru.js';
import { readMobiIndxTable } from './indx.js';
import { snapToSafeUtf8TagBoundary } from './kf8.js';
import type { ParsedMobiRecord0 } from './pdb.js';
import { ensureTextBinSource, loadMobiResourceRecord } from './resources.js';

const PAGEBREAK_REGEX = /<mbp:pagebreak(?:\s[^>]*)?\/?>/gi;
const FILEPOS_ATTR_REGEX = /\bfilepos\s*=\s*(?:["']0*(\d+)["']|0*(\d+))/gi;

function findMobi6SectionForByteOffset(sections: readonly Mobi6SectionIndex[], bytePos: number): number {
  let lo = 0;
  let hi = sections.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const sec = sections[mid]!;
    if (bytePos < sec.byteStart) hi = mid - 1;
    else if (bytePos >= sec.byteEnd) lo = mid + 1;
    else return sec.index;
  }
  return sections.length > 0 ? Math.min(sections.length - 1, Math.max(0, lo)) : 0;
}

export async function buildMobi6IndexFromStream(params: {
  readonly src: ByteSource;
  readonly recordOffsets: readonly number[];
  readonly record0Index: number;
  readonly header: ParsedMobiRecord0;
  readonly textStream: Uint8Array;
}): Promise<Mobi6BookIndex> {
  const { src, recordOffsets, record0Index, header, textStream } = params;

  // Decode ASCII/Latin-1 view of `textStream` (1 byte === 1 char in ISO-8859-1!) so regex indices
  // over ASCII `<mbp:pagebreak>` and `filepos="..."` equal exact byte offsets in `textStream`!
  const latin1View = new TextDecoder('iso-8859-1').decode(textStream);

  const rawRanges: Array<{ byteStart: number; byteEnd: number }> = [];
  let lastPos = 0;
  PAGEBREAK_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGEBREAK_REGEX.exec(latin1View)) !== null) {
    const pbStart = m.index;
    const pbEnd = m.index + m[0].length;
    if (pbStart > lastPos && latin1View.slice(lastPos, pbStart).trim().length > 0) {
      rawRanges.push({ byteStart: lastPos, byteEnd: pbStart });
    }
    lastPos = pbEnd;
  }
  if (lastPos < textStream.byteLength && (rawRanges.length === 0 || latin1View.slice(lastPos).trim().length > 0)) {
    rawRanges.push({ byteStart: lastPos, byteEnd: textStream.byteLength });
  }
  if (rawRanges.length === 0) {
    rawRanges.push({ byteStart: 0, byteEnd: textStream.byteLength });
  }

  const allFilepos = new Set<number>();
  FILEPOS_ATTR_REGEX.lastIndex = 0;
  while ((m = FILEPOS_ATTR_REGEX.exec(latin1View)) !== null) {
    const numStr = m[1] ?? m[2] ?? '0';
    const fp = Number.parseInt(numStr, 10);
    if (Number.isFinite(fp) && fp >= 0 && fp <= textStream.byteLength) {
      allFilepos.add(fp);
    }
  }

  // Optional NCX INDX TOC (`ARCHITECTURE.md` §4.4)
  const rawTocItems: Array<{ title: string; filepos: number }> = [];
  if (header.ncxIndex >= 0 && record0Index + header.ncxIndex < recordOffsets.length) {
    try {
      const ncx = await readMobiIndxTable(src, recordOffsets, src.size, record0Index + header.ncxIndex);
      for (const entry of ncx.entries) {
        const title = (ncx.getCncxString(entry.tags[3]?.[0]) ?? entry.label).replace(/\s+/g, ' ').trim();
        const fp = entry.tags[1]?.[0];
        if (title && fp !== undefined) {
          allFilepos.add(fp);
          rawTocItems.push({ title, filepos: fp });
        }
      }
    } catch {
      // Ignore malformed optional NCX
    }
  }

  const sections: Mobi6SectionIndex[] = rawRanges.map((r, idx) => ({
    index: idx,
    byteStart: r.byteStart,
    byteEnd: r.byteEnd,
    anchors: [],
  }));

  const sectionAnchors: number[][] = sections.map(() => []);
  for (const fp of allFilepos) {
    const secIdx = findMobi6SectionForByteOffset(sections, fp);
    sectionAnchors[secIdx]?.push(fp);
  }
  for (let i = 0; i < sections.length; i++) {
    const sorted = [...new Set(sectionAnchors[i]!)].sort((a, b) => a - b);
    sections[i] = { ...sections[i]!, anchors: sorted };
  }

  const spine: SectionRef[] = sections.map((sec) => ({
    index: sec.index,
    linear: true,
    sizeHint: Math.max(64, Math.floor((sec.byteEnd - sec.byteStart) * 0.7)),
  }));

  let toc: TocItem[] = rawTocItems.map((t) => {
    const secIdx = findMobi6SectionForByteOffset(sections, t.filepos);
    return {
      title: t.title,
      locator: { section: secIdx, offset: 0 },
      href: `${secIdx}#mb-fp-${t.filepos}`,
      children: [],
    };
  });

  if (toc.length === 0) {
    // Fallback: extract first heading from each section (`§4.4`)
    for (const sec of sections) {
      const sliceStr = decodeBytesWithEncoding(
        textStream.subarray(sec.byteStart, Math.min(sec.byteEnd, sec.byteStart + 2048)),
        header.encoding,
      );
      const hMatch = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(sliceStr);
      const cleanTitle = hMatch?.[1]
        ? hMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        : '';
      if (cleanTitle) {
        spine[sec.index] = { ...spine[sec.index]!, title: cleanTitle };
        toc.push({
          title: cleanTitle,
          locator: { section: sec.index, offset: 0 },
          children: [],
        });
      }
    }
  } else {
    for (const item of toc) {
      const sp = spine[item.locator.section];
      if (sp && !sp.title) {
        spine[item.locator.section] = { ...sp, title: item.title };
      }
    }
  }

  if (toc.length === 0) {
    toc = spine.map((s, idx) => ({
      title: s.title || `Section ${idx + 1}`,
      locator: { section: s.index, offset: 0 },
      children: [],
    }));
  }

  const firstImageGlobal =
    header.firstImageIndex >= 0 ? record0Index + header.firstImageIndex : -1;
  let coverRecordIndex: number | null = null;
  if (header.exth.coverOffset !== undefined && firstImageGlobal >= 0) {
    const cand = firstImageGlobal + header.exth.coverOffset;
    if (cand < recordOffsets.length) coverRecordIndex = cand;
  }

  const meta: BookMeta = {
    title: header.title,
    authors: header.exth.authors,
    language: header.exth.language ?? header.localeLang,
    identifier: header.exth.identifier ?? (header.uid ? String(header.uid) : null),
    format: 'mobi',
    direction: header.exth.direction ?? 'ltr',
    fixedLayout: false,
    ...(header.exth.description ? { description: header.exth.description } : {}),
    ...(header.exth.publisher ? { publisher: header.exth.publisher } : {}),
    ...(header.exth.publishedAt ? { publishedAt: header.exth.publishedAt } : {}),
  };

  return {
    kind: 'mobi6',
    meta,
    toc,
    spine,
    encoding: header.encoding,
    pdbRecordOffsets: recordOffsets,
    record0Index,
    firstImageRecord: firstImageGlobal,
    sections,
    coverRecordIndex,
  };
}

function injectMobi6FileposAnchors(
  sectionBytes: Uint8Array,
  sectionByteStart: number,
  anchors: readonly number[],
  encoding: 'utf-8' | 'windows-1252',
): Uint8Array {
  if (anchors.length === 0) return sectionBytes;
  const enc = new TextEncoder();
  const resolved: Array<{ pos: number; fp: number }> = [];

  for (const fp of anchors) {
    const localPos = Math.max(0, Math.min(sectionBytes.byteLength, fp - sectionByteStart));
    const safePos =
      encoding === 'utf-8'
        ? snapToSafeUtf8TagBoundary(sectionBytes, localPos, 0, sectionBytes.byteLength)
        : snapAsciiTagBoundary(sectionBytes, localPos);
    resolved.push({ pos: safePos, fp });
  }
  resolved.sort((a, b) => a.pos - b.pos);

  const pieces: Uint8Array[] = [];
  let cursor = 0;
  for (const item of resolved) {
    if (item.pos > cursor) {
      pieces.push(sectionBytes.subarray(cursor, item.pos));
      cursor = item.pos;
    }
    pieces.push(enc.encode(`<a id="mb-fp-${item.fp}"></a>`));
  }
  if (cursor < sectionBytes.byteLength) {
    pieces.push(sectionBytes.subarray(cursor));
  }
  return concatBytes(pieces);
}

function snapAsciiTagBoundary(bytes: Uint8Array, rawPos: number): number {
  let idx = Math.max(0, Math.min(bytes.byteLength, rawPos));
  let back = idx - 1;
  let insideTag = false;
  while (back >= 0 && idx - back <= 1024) {
    if (bytes[back] === 0x3e) break;
    if (bytes[back] === 0x3c) {
      insideTag = true;
      break;
    }
    back--;
  }
  if (insideTag) {
    while (idx < bytes.byteLength && bytes[idx] !== 0x3e) idx++;
    if (idx < bytes.byteLength && bytes[idx] === 0x3e) idx++;
  }
  return idx;
}

export async function createMobi6Session(
  src: ByteSource,
  hint: BookOpenHint,
  index: Mobi6BookIndex,
): Promise<BookSession> {
  const textBin = await ensureTextBinSource({
    src,
    ...(hint.getDerived ? { getDerived: hint.getDerived } : {}),
    recordOffsets: index.pdbRecordOffsets,
    record0Index: index.record0Index,
  });

  const sectionCache = new LruCache<number, BuiltSectionUnits>(4);
  const anchorOffsets = new Map<number, ReadonlyMap<string, number>>();

  const loadUnits = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const hit = sectionCache.get(sectionIndex);
    if (hit) return hit;

    const secInfo = index.sections[sectionIndex];
    if (!secInfo) {
      throw new MiniBookError('not-found', `MOBI 6 section ${sectionIndex} out of range`);
    }

    const rawSlice = await textBin.read(secInfo.byteStart, secInfo.byteEnd - secInfo.byteStart);
    const anchoredBytes = injectMobi6FileposAnchors(
      rawSlice,
      secInfo.byteStart,
      secInfo.anchors,
      index.encoding,
    );
    let htmlStr = decodeBytesWithEncoding(anchoredBytes, index.encoding);

    // Rewrite `<img ... recindex="00001">` -> `src="mobi-rec:0"` (`ARCHITECTURE.md` §4.4)
    htmlStr = htmlStr.replace(
      /<img\b([^>]*?)\brecindex\s*=\s*(?:["']0*(\d+)["']|0*(\d+))([^>]*)>/gi,
      (_m, before: string, qNum: string | undefined, bNum: string | undefined, after: string) => {
        const oneBased = Number.parseInt(qNum ?? bNum ?? '1', 10);
        const zeroBased = Math.max(0, oneBased - 1);
        return `<img${before} src="mobi-rec:${zeroBased}"${after}>`;
      },
    );

    // Rewrite `<a ... filepos="0000123">` -> `href="filepos:123"`
    htmlStr = htmlStr.replace(
      /<a\b([^>]*?)\bfilepos\s*=\s*(?:["']0*(\d+)["']|0*(\d+))([^>]*)>/gi,
      (_m, before: string, qNum: string | undefined, bNum: string | undefined, after: string) => {
        const fp = Number.parseInt(qNum ?? bNum ?? '0', 10);
        return `<a${before} href="filepos:${fp}"${after}>`;
      },
    );

    const parsedDoc = parseHtmlDocument(htmlStr);
    const sanitized = await sanitizeDocument(parsedDoc, {
      sectionPath: `section-${sectionIndex}.html`,
      defaultLang: index.meta.language,
      defaultDir: index.meta.direction,
      resolveResourceUrl: (rawUrl) => {
        const trimmed = rawUrl.trim();
        if (trimmed.startsWith('mobi-rec:')) {
          return { placeholder: `mb-res:${trimmed}`, resourcePath: trimmed };
        }
        return null;
      },
      resolveLinkHref: (rawHref) => {
        const trimmed = rawHref.trim();
        if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
        if (trimmed.startsWith('filepos:')) {
          const fp = Number.parseInt(trimmed.slice('filepos:'.length), 10);
          if (!Number.isFinite(fp)) return null;
          const targetSec = findMobi6SectionForByteOffset(index.sections, fp);
          return { loc: `${targetSec}#mb-fp-${fp}` };
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
        throw new MiniBookError('not-found', `MOBI 6 book has no image records for "${href}"`);
      }
      if (href.startsWith('mobi-rec:')) {
        const offset = Number.parseInt(href.slice('mobi-rec:'.length), 10);
        if (!Number.isFinite(offset) || offset < 0) {
          throw new MiniBookError('not-found', `Invalid MOBI resource "${href}"`);
        }
        return loadMobiResourceRecord(src, index.pdbRecordOffsets, index.firstImageRecord + offset);
      }
      throw new MiniBookError('not-found', `Unknown MOBI 6 resource "${href}"`);
    },

    resolveHref(fromSection: number, href: string): ResolvedHref {
      const trimmed = href.trim();
      if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
      const mbLoc = /^(\d+)(?::(\d+)|#(.+))?$/.exec(trimmed);
      if (mbLoc) {
        const sec = Number.parseInt(mbLoc[1]!, 10);
        if (sec < 0 || sec >= index.spine.length) return null;
        if (mbLoc[2] !== undefined) return { section: sec, offset: Number.parseInt(mbLoc[2], 10) };
        const frag = mbLoc[3];
        const off = frag ? (anchorOffsets.get(sec)?.get(frag) ?? 0) : 0;
        return { section: sec, offset: off };
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
      sectionCache.clear();
      anchorOffsets.clear();
    },
  };
}
