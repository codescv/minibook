import { sanitizeDocument } from '../../book/sanitize.js';
import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { decodeBytesWithEncoding, normalizeEncodingLabel } from '../../io/encoding.js';
import { ZipArchive } from '../../io/zip.js';
import {
  childElements,
  el,
  findFirst,
  getAttr,
  localName,
  type MElement,
  type MNode,
  textContent,
  txt,
} from '../../markup/mnode.js';
import { parseXml, sniffXmlDeclarationEncoding } from '../../markup/xml-tokenizer.js';
import type {
  BookMeta,
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  Fb2BinaryRange,
  Fb2BookIndex,
  Fb2SectionRange,
  InspectedBook,
  ResolvedHref,
  SectionDoc,
  SectionRef,
  SectionText,
  TocItem,
} from '../../types.js';
import { base64ToBytes } from '../../util/base32.js';
import { LruCache } from '../../util/lru.js';
import { mimeFromMagic } from '../../util/path.js';

const ASCII_BINARY_OPEN = new TextEncoder().encode('<binary');
const ASCII_BINARY_CLOSE = new TextEncoder().encode('</binary>');

function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array, fromIndex: number): number {
  const limit = haystack.byteLength - needle.byteLength;
  outer: for (let i = fromIndex; i <= limit; i++) {
    for (let k = 0; k < needle.byteLength; k++) {
      // Case-insensitive ASCII compare for `<binary` / `</binary>`
      const a = haystack[i + k]! | 0x20;
      const b = needle[k]! | 0x20;
      if (a !== b && haystack[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Scans `<binary id="..." content-type="...">...</binary>` byte ranges in raw FB2 bytes
 * so binary Base64 payloads are indexed by byte offset and stripped before XML tree construction
 * (`ARCHITECTURE.md` §4.5: decoded on demand, never all at once).
 */
function scanAndStripFb2Binaries(rawBytes: Uint8Array): {
  readonly strippedBytes: Uint8Array;
  readonly binaries: Record<string, Fb2BinaryRange>;
} {
  const binaries: Record<string, Fb2BinaryRange> = {};
  const keptSlices: Uint8Array[] = [];
  let cursor = 0;
  const asciiDecoder = new TextDecoder('utf-8', { fatal: false });

  while (cursor < rawBytes.byteLength) {
    const openPos = indexOfSubarray(rawBytes, ASCII_BINARY_OPEN, cursor);
    if (openPos < 0) {
      keptSlices.push(rawBytes.subarray(cursor));
      break;
    }
    const nextByte = rawBytes[openPos + ASCII_BINARY_OPEN.byteLength] ?? 0;
    if (nextByte !== 0x20 && nextByte !== 0x09 && nextByte !== 0x0a && nextByte !== 0x0d && nextByte !== 0x3e) {
      keptSlices.push(rawBytes.subarray(cursor, openPos + ASCII_BINARY_OPEN.byteLength));
      cursor = openPos + ASCII_BINARY_OPEN.byteLength;
      continue;
    }

    let gtPos = -1;
    for (let k = openPos + ASCII_BINARY_OPEN.byteLength; k < Math.min(rawBytes.byteLength, openPos + 1024); k++) {
      if (rawBytes[k] === 0x3e) {
        gtPos = k;
        break;
      }
    }
    if (gtPos < 0) {
      keptSlices.push(rawBytes.subarray(cursor));
      break;
    }

    const closePos = indexOfSubarray(rawBytes, ASCII_BINARY_CLOSE, gtPos + 1);
    if (closePos < 0) {
      keptSlices.push(rawBytes.subarray(cursor));
      break;
    }

    const tagText = asciiDecoder.decode(rawBytes.subarray(openPos, gtPos + 1));
    const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(tagText);
    const mimeMatch = /\bcontent-type\s*=\s*["']([^"']+)["']/i.exec(tagText);
    if (idMatch?.[1]) {
      const id = idMatch[1].trim();
      binaries[id] = {
        id,
        mime: mimeMatch?.[1]?.trim() || 'image/jpeg',
        byteStart: gtPos + 1,
        byteEnd: closePos,
      };
    }

    keptSlices.push(rawBytes.subarray(cursor, openPos));
    cursor = closePos + ASCII_BINARY_CLOSE.byteLength;
  }

  let total = 0;
  for (const s of keptSlices) total += s.byteLength;
  const strippedBytes = new Uint8Array(total);
  let writeOff = 0;
  for (const s of keptSlices) {
    strippedBytes.set(s, writeOff);
    writeOff += s.byteLength;
  }
  return { strippedBytes, binaries };
}

function getFb2Href(node: MElement): string | undefined {
  return (
    getAttr(node, 'l:href') ??
    getAttr(node, 'xlink:href') ??
    getAttr(node, 'href')
  )?.trim();
}

function convertFb2ElementToXhtml(node: MElement, depth: number): MNode[] {
  const tag = localName(node.tag).toLowerCase();
  const id = getAttr(node, 'id')?.trim();
  const baseAttrs: Record<string, string> = id ? { id } : {};

  const mapChildren = (nextDepth: number): MNode[] => {
    const out: MNode[] = [];
    for (const c of node.children) {
      if (c.type === 'text') {
        out.push(txt(c.value));
      } else {
        out.push(...convertFb2ElementToXhtml(c, nextDepth));
      }
    }
    return out;
  };

  switch (tag) {
    case 'section':
    case 'body':
      return [el('section', baseAttrs, mapChildren(depth + 1))];
    case 'title': {
      const hLevel = Math.min(3, Math.max(1, depth));
      const headingTextNodes: MNode[] = [];
      const pNodes = childElements(node, 'p');
      if (pNodes.length > 0) {
        pNodes.forEach((p, idx) => {
          if (idx > 0) headingTextNodes.push(txt(' — '));
          for (const pc of p.children) {
            if (pc.type === 'text') headingTextNodes.push(txt(pc.value));
            else headingTextNodes.push(...convertFb2ElementToXhtml(pc, depth));
          }
        });
      } else {
        headingTextNodes.push(...mapChildren(depth));
      }
      return [el(`h${hLevel}`, baseAttrs, headingTextNodes)];
    }
    case 'subtitle':
      return [el('h4', baseAttrs, mapChildren(depth))];
    case 'p':
      return [el('p', baseAttrs, mapChildren(depth))];
    case 'v':
      return [el('p', { ...baseAttrs, class: 'verse' }, mapChildren(depth))];
    case 'poem':
      return [el('div', { ...baseAttrs, class: 'poem' }, mapChildren(depth))];
    case 'stanza':
      return [el('div', { ...baseAttrs, class: 'stanza' }, mapChildren(depth))];
    case 'epigraph':
    case 'cite':
      return [el('blockquote', baseAttrs, mapChildren(depth))];
    case 'text-author':
      return [el('p', { ...baseAttrs, class: 'text-author' }, mapChildren(depth))];
    case 'empty-line':
      return [el('div', { ...baseAttrs, class: 'mb-spacer', 'aria-hidden': 'true' }, [])];
    case 'emphasis':
      return [el('em', baseAttrs, mapChildren(depth))];
    case 'strong':
      return [el('strong', baseAttrs, mapChildren(depth))];
    case 'strikethrough':
      return [el('s', baseAttrs, mapChildren(depth))];
    case 'sub':
    case 'sup':
    case 'code':
    case 'table':
    case 'tr':
    case 'th':
    case 'td':
      return [el(tag, baseAttrs, mapChildren(depth))];
    case 'a': {
      const href = getFb2Href(node) ?? '#';
      const isNote = (getAttr(node, 'type') ?? '').toLowerCase() === 'note';
      const aAttrs: Record<string, string> = { ...baseAttrs, href };
      if (isNote) {
        aAttrs['epub:type'] = 'noteref';
        aAttrs['role'] = 'doc-noteref';
      }
      return [el('a', aAttrs, mapChildren(depth))];
    }
    case 'image': {
      const href = getFb2Href(node);
      if (!href) return [];
      const binId = href.startsWith('#') ? href.slice(1) : href;
      const alt = getAttr(node, 'alt') ?? '';
      return [el('img', { ...baseAttrs, src: `fb2-bin:${binId}`, ...(alt ? { alt } : {}) }, [])];
    }
    case 'annotation':
      return [el('div', { ...baseAttrs, class: 'annotation' }, mapChildren(depth))];
    default:
      return mapChildren(depth);
  }
}

interface ParsedFb2Model {
  readonly meta: BookMeta;
  readonly coverBinaryId: string | null;
  readonly sections: Array<{
    readonly info: Fb2SectionRange;
    readonly node: MElement;
    readonly depth: number;
  }>;
  readonly toc: TocItem[];
  readonly spine: SectionRef[];
  readonly anchorToSection: Map<string, number>;
}

function parseFb2Tree(root: MElement, fileName: string): ParsedFb2Model {
  const desc = findFirst(root, (n) => localName(n.tag).toLowerCase() === 'description');
  const titleInfo = desc
    ? findFirst(desc, (n) => localName(n.tag).toLowerCase() === 'title-info')
    : null;

  let title = '';
  const authors: string[] = [];
  let language: string | null = null;
  let description: string | undefined;
  let coverBinaryId: string | null = null;

  if (titleInfo) {
    const bt = childElements(titleInfo, 'book-title')[0];
    if (bt) title = textContent(bt).trim();

    for (const authEl of childElements(titleInfo, 'author')) {
      const parts = [
        textContent(childElements(authEl, 'first-name')[0] ?? txt('')).trim(),
        textContent(childElements(authEl, 'middle-name')[0] ?? txt('')).trim(),
        textContent(childElements(authEl, 'last-name')[0] ?? txt('')).trim(),
      ].filter(Boolean);
      if (parts.length > 0) {
        authors.push(parts.join(' '));
      } else {
        const nick = childElements(authEl, 'nickname')[0];
        if (nick && textContent(nick).trim()) authors.push(textContent(nick).trim());
      }
    }

    const langEl = childElements(titleInfo, 'lang')[0];
    if (langEl && textContent(langEl).trim()) {
      language = textContent(langEl).trim();
    }

    const annEl = childElements(titleInfo, 'annotation')[0];
    if (annEl && textContent(annEl).trim()) {
      description = textContent(annEl).trim();
    }

    const coverEl = childElements(titleInfo, 'coverpage')[0];
    if (coverEl) {
      const imgEl = findFirst(coverEl, (n) => localName(n.tag).toLowerCase() === 'image');
      if (imgEl) {
        const href = getFb2Href(imgEl);
        if (href) coverBinaryId = href.startsWith('#') ? href.slice(1) : href;
      }
    }
  }

  if (!title) {
    title = fileName.replace(/\.fb2(?:\.zip)?$/i, '').replace(/^.*\//, '') || 'Untitled';
  }

  const bodies = childElements(root, 'body');
  if (bodies.length === 0) {
    throw new MiniBookError('corrupt-book', 'FB2 document contains no <body> element');
  }

  const sections: ParsedFb2Model['sections'] = [];
  const toc: TocItem[] = [];

  const extractTitleOf = (secNode: MElement): string | undefined => {
    const t = childElements(secNode, 'title')[0];
    if (!t) return undefined;
    const raw = textContent(t).replace(/\s+/g, ' ').trim();
    return raw || undefined;
  };

  // Split main `<body>` at `<section>` depth <= 2 (`ARCHITECTURE.md` §4.5)
  const addMainSection = (secNode: MElement, depth: number, parentTocList: TocItem[]) => {
    const childSecs = childElements(secNode, 'section');
    const secTitle = extractTitleOf(secNode);

    if (depth < 2 && childSecs.length > 0) {
      // Check if there is preamble content before child `<section>`s
      const preambleChildren = secNode.children.filter(
        (c) => !(c.type === 'element' && localName(c.tag).toLowerCase() === 'section'),
      );
      const preambleTextLen = preambleChildren.reduce(
        (acc, c) => acc + textContent(c).trim().length,
        0,
      );

      let groupStartIndex = sections.length;
      if (preambleTextLen > 0) {
        const preambleNode = el('section', { ...secNode.attrs }, preambleChildren);
        const idx = sections.length;
        groupStartIndex = idx;
        sections.push({
          info: {
            index: idx,
            ...(getAttr(secNode, 'id') ? { id: getAttr(secNode, 'id')! } : {}),
            ...(secTitle ? { title: secTitle } : {}),
            linear: true,
            sizeHint: Math.max(64, preambleTextLen),
          },
          node: preambleNode,
          depth,
        });
      }

      const childToc: TocItem[] = [];
      for (const cs of childSecs) {
        addMainSection(cs, depth + 1, childToc);
      }

      if (secTitle) {
        parentTocList.push({
          title: secTitle,
          locator: { section: childToc[0]?.locator.section ?? groupStartIndex, offset: 0 },
          children: childToc,
        });
      } else {
        parentTocList.push(...childToc);
      }
      return;
    }

    const idx = sections.length;
    const charLen = Math.max(64, textContent(secNode).length);
    sections.push({
      info: {
        index: idx,
        ...(getAttr(secNode, 'id') ? { id: getAttr(secNode, 'id')! } : {}),
        ...(secTitle ? { title: secTitle } : {}),
        linear: true,
        sizeHint: charLen,
      },
      node: secNode,
      depth,
    });

    if (secTitle) {
      parentTocList.push({
        title: secTitle,
        locator: { section: idx, offset: 0 },
        children: [],
      });
    }
  };

  for (let bIdx = 0; bIdx < bodies.length; bIdx++) {
    const body = bodies[bIdx]!;
    const bodyName = (getAttr(body, 'name') ?? '').trim().toLowerCase();
    const isNotes = bIdx > 0 && (bodyName === 'notes' || bodyName === 'comments' || bodyName === 'footnotes');

    if (isNotes) {
      const idx = sections.length;
      const notesTitle = extractTitleOf(body) ?? 'Notes';
      sections.push({
        info: {
          index: idx,
          title: notesTitle,
          linear: false,
          isNotes: true,
          sizeHint: Math.max(64, textContent(body).length),
        },
        node: body,
        depth: 1,
      });
    } else {
      const topSections = childElements(body, 'section');
      if (topSections.length > 0) {
        for (const s of topSections) {
          addMainSection(s, 1, toc);
        }
      } else {
        const idx = sections.length;
        sections.push({
          info: {
            index: idx,
            title,
            linear: true,
            sizeHint: Math.max(64, textContent(body).length),
          },
          node: body,
          depth: 1,
        });
      }
    }
  }

  // Index every `id` attribute across sections so `#note1` jumps to the exact section (including non-linear notes!)
  const anchorToSection = new Map<string, number>();
  const indexIds = (node: MElement, secIdx: number) => {
    const id = getAttr(node, 'id')?.trim();
    if (id && !anchorToSection.has(id)) {
      anchorToSection.set(id, secIdx);
    }
    for (const c of node.children) {
      if (c.type === 'element') indexIds(c, secIdx);
    }
  };
  for (const s of sections) {
    indexIds(s.node, s.info.index);
  }

  const spine: SectionRef[] = sections.map((s) => ({
    index: s.info.index,
    ...(s.info.id ? { id: s.info.id } : {}),
    ...(s.info.title ? { title: s.info.title } : {}),
    linear: s.info.linear,
    sizeHint: s.info.sizeHint,
  }));

  if (toc.length === 0) {
    spine
      .filter((s) => s.linear)
      .forEach((s, i) => {
        toc.push({
          title: s.title || `Section ${i + 1}`,
          locator: { section: s.index, offset: 0 },
          children: [],
        });
      });
  }

  const meta: BookMeta = {
    title,
    authors,
    language,
    identifier: null,
    format: 'fb2',
    direction: 'ltr',
    fixedLayout: false,
    ...(description !== undefined ? { description } : {}),
  };

  return {
    meta,
    coverBinaryId,
    sections,
    toc,
    spine,
    anchorToSection,
  };
}

async function loadRawFb2Bytes(
  src: ByteSource,
  zipped: boolean,
  existingZip?: ZipArchive,
  zipEntry?: Fb2BookIndex['zipEntry'],
): Promise<{ readonly rawBytes: Uint8Array; readonly foundZipEntry?: NonNullable<Fb2BookIndex['zipEntry']> }> {
  if (!zipped) {
    const rawBytes = src.readAll ? await src.readAll() : await src.read(0, src.size);
    return { rawBytes };
  }
  const zip = existingZip ?? (await ZipArchive.open(src, zipEntry ? [zipEntry] : undefined));
  const entry =
    zipEntry ??
    zip.entries.find((e) => e.name.toLowerCase().endsWith('.fb2')) ??
    zip.entries[0];
  if (!entry) {
    throw new MiniBookError('corrupt-book', 'Zipped FB2 archive contains no .fb2 file');
  }
  const rawBytes = await zip.readEntry(entry);
  return { rawBytes, foundZipEntry: entry };
}

export async function inspectFb2(
  src: ByteSource,
  fileName: string,
  zipped: boolean,
  existingZip?: ZipArchive,
): Promise<InspectedBook> {
  const { rawBytes, foundZipEntry } = await loadRawFb2Bytes(src, zipped, existingZip);
  const encoding = normalizeEncodingLabel(sniffXmlDeclarationEncoding(rawBytes) ?? 'utf-8');
  const { strippedBytes, binaries } = scanAndStripFb2Binaries(rawBytes);
  const xmlText = decodeBytesWithEncoding(strippedBytes, encoding);
  const root = parseXml(xmlText, { strict: false });
  const model = parseFb2Tree(root, fileName);

  let cover: CoverImage | null = null;
  if (model.coverBinaryId && binaries[model.coverBinaryId]) {
    const binInfo = binaries[model.coverBinaryId]!;
    const b64Slice = rawBytes.subarray(binInfo.byteStart, binInfo.byteEnd);
    const b64Str = new TextDecoder('utf-8', { fatal: false }).decode(b64Slice);
    const bytes = base64ToBytes(b64Str);
    if (bytes.byteLength > 0) {
      cover = { bytes, mime: mimeFromMagic(bytes, binInfo.mime) };
    }
  }

  const index: Fb2BookIndex = {
    kind: 'fb2',
    zipped,
    ...(foundZipEntry ? { zipEntry: foundZipEntry } : {}),
    encoding,
    meta: model.meta,
    toc: model.toc,
    spine: model.spine,
    sections: model.sections.map((s) => s.info),
    coverBinaryId: model.coverBinaryId,
    binaries,
  };

  return { meta: model.meta, cover, index };
}

export async function openFb2Session(
  src: ByteSource,
  fileName: string,
  preloadedIndex?: Fb2BookIndex,
  existingZip?: ZipArchive,
): Promise<BookSession> {
  let index = preloadedIndex;
  let cachedModel: ParsedFb2Model | null = null;
  let cachedZippedRawBytes: Uint8Array | null = null;

  if (!index) {
    const zipped = Boolean(existingZip) || fileName.toLowerCase().endsWith('.zip') || fileName.toLowerCase().endsWith('.fbz');
    const { rawBytes, foundZipEntry } = await loadRawFb2Bytes(src, zipped, existingZip);
    if (zipped) cachedZippedRawBytes = rawBytes;
    const encoding = normalizeEncodingLabel(sniffXmlDeclarationEncoding(rawBytes) ?? 'utf-8');
    const { strippedBytes, binaries } = scanAndStripFb2Binaries(rawBytes);
    const xmlText = decodeBytesWithEncoding(strippedBytes, encoding);
    const root = parseXml(xmlText, { strict: false });
    cachedModel = parseFb2Tree(root, fileName);
    index = {
      kind: 'fb2',
      zipped,
      ...(foundZipEntry ? { zipEntry: foundZipEntry } : {}),
      encoding,
      meta: cachedModel.meta,
      toc: cachedModel.toc,
      spine: cachedModel.spine,
      sections: cachedModel.sections.map((s) => s.info),
      coverBinaryId: cachedModel.coverBinaryId,
      binaries,
    };
  }

  const ensureModel = async (): Promise<ParsedFb2Model> => {
    if (cachedModel) return cachedModel;
    const { rawBytes } = await loadRawFb2Bytes(src, index!.zipped, existingZip, index!.zipEntry);
    if (index!.zipped) cachedZippedRawBytes = rawBytes;
    const { strippedBytes } = scanAndStripFb2Binaries(rawBytes);
    const xmlText = decodeBytesWithEncoding(strippedBytes, index!.encoding);
    const root = parseXml(xmlText, { strict: false });
    cachedModel = parseFb2Tree(root, fileName);
    return cachedModel;
  };

  const sectionCache = new LruCache<number, BuiltSectionUnits>(4);
  const anchorOffsets = new Map<number, ReadonlyMap<string, number>>();

  const loadSectionUnitsInternal = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const hit = sectionCache.get(sectionIndex);
    if (hit) return hit;

    const model = await ensureModel();
    const secEntry = model.sections[sectionIndex];
    if (!secEntry) {
      throw new MiniBookError('not-found', `FB2 section ${sectionIndex} out of range`);
    }

    const xhtmlNodes = convertFb2ElementToXhtml(secEntry.node, secEntry.depth);
    const fakeBody = el('body', {}, xhtmlNodes, 'xhtml');
    const sanitized = await sanitizeDocument(fakeBody, {
      sectionPath: `section-${sectionIndex}.xhtml`,
      defaultLang: index!.meta.language,
      defaultDir: index!.meta.direction,
      resolveResourceUrl: (rawUrl) => {
        if (rawUrl.startsWith('fb2-bin:')) {
          const binId = rawUrl.slice('fb2-bin:'.length);
          return { placeholder: `mb-res:fb2-bin:${binId}`, resourcePath: `fb2-bin:${binId}` };
        }
        return null;
      },
      resolveLinkHref: (rawHref) => {
        const trimmed = rawHref.trim();
        if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
        if (trimmed.startsWith('#')) {
          const frag = trimmed.slice(1);
          const targetSec = model.anchorToSection.get(frag) ?? sectionIndex;
          return { loc: `${targetSec}#${frag}` };
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
      css: '',
      lang: sanitized.lang,
      dir: sanitized.dir,
      resources: sanitized.resources,
      isCoverLike: sanitized.isCoverLike,
    });
    sectionCache.set(sectionIndex, built);
    return built;
  };

  const readBinaryById = async (binId: string): Promise<BookResource> => {
    const range = index!.binaries[binId];
    if (!range) {
      throw new MiniBookError('not-found', `FB2 binary "${binId}" not found`);
    }
    let slice: Uint8Array;
    if (!index!.zipped) {
      // On-demand ranged read straight from `ByteSource` (`ARCHITECTURE.md` §4.5)!
      slice = await src.read(range.byteStart, range.byteEnd - range.byteStart);
    } else {
      if (!cachedZippedRawBytes) {
        const loaded = await loadRawFb2Bytes(src, true, existingZip, index!.zipEntry);
        cachedZippedRawBytes = loaded.rawBytes;
      }
      slice = cachedZippedRawBytes.subarray(range.byteStart, range.byteEnd);
    }
    const b64 = new TextDecoder('utf-8', { fatal: false }).decode(slice);
    const bytes = base64ToBytes(b64);
    const mime = mimeFromMagic(bytes, range.mime);
    return { bytes, mime };
  };

  return {
    meta: index.meta,
    toc: index.toc as TocItem[],
    spine: index.spine,

    async loadSection(sectionIndex: number, unitIndex = 0): Promise<SectionDoc> {
      const built = await loadSectionUnitsInternal(sectionIndex);
      const clamped = Math.max(0, Math.min(built.units.length - 1, unitIndex));
      return built.units[clamped]!;
    },

    async loadSectionUnits(sectionIndex: number): Promise<readonly SectionDoc[]> {
      const built = await loadSectionUnitsInternal(sectionIndex);
      return built.units;
    },

    async loadSectionText(sectionIndex: number): Promise<SectionText> {
      const built = await loadSectionUnitsInternal(sectionIndex);
      return built.fullText;
    },

    async loadResource(href: string): Promise<BookResource> {
      const binId = href.startsWith('fb2-bin:')
        ? href.slice('fb2-bin:'.length)
        : href.replace(/^#/, '');
      return readBinaryById(binId);
    },

    resolveHref(_fromSection: number, href: string): ResolvedHref {
      const trimmed = href.trim();
      if (/^(?:https?:|mailto:)/i.test(trimmed)) return { external: trimmed };
      const mbLoc = /^(\d+)(?::(\d+)|#(.+))?$/.exec(trimmed);
      if (mbLoc) {
        const sec = Number.parseInt(mbLoc[1]!, 10);
        if (mbLoc[2] !== undefined) return { section: sec, offset: Number.parseInt(mbLoc[2], 10) };
        const frag = mbLoc[3];
        const off = frag ? (anchorOffsets.get(sec)?.get(frag) ?? 0) : 0;
        return { section: sec, offset: off };
      }
      if (trimmed.startsWith('#') && cachedModel) {
        const frag = trimmed.slice(1);
        const sec = cachedModel.anchorToSection.get(frag);
        if (sec !== undefined) {
          return { section: sec, offset: anchorOffsets.get(sec)?.get(frag) ?? 0 };
        }
      }
      return null;
    },

    async cover(): Promise<CoverImage | null> {
      if (!index!.coverBinaryId) return null;
      try {
        return await readBinaryById(index!.coverBinaryId);
      } catch {
        return null;
      }
    },

    close(): void {
      sectionCache.clear();
      anchorOffsets.clear();
      cachedZippedRawBytes = null;
    },
  };
}
