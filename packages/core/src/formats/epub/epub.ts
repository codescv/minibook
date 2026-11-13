import { sanitizeDocument } from '../../book/sanitize.js';
import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { MAX_ENTRY_BYTES_MARKUP, ZipArchive } from '../../io/zip.js';
import { parseXhtmlOrHtml } from '../../markup/html.js';
import { findFirst, getAttr, localName, type MNode, textContent } from '../../markup/mnode.js';
import type {
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  EpubBookIndex,
  InspectedBook,
  Locator,
  ReadingDirection,
  ResolvedHref,
  SectionDoc,
  SectionRef,
  SectionText,
  TocItem,
} from '../../types.js';
import { LruCache } from '../../util/lru.js';
import {
  mimeFromMagic,
  mimeFromPath,
  normalizeArchivePath,
  resolveArchiveHref,
  safeDecodeUriComponent,
} from '../../util/path.js';
import { buildFallbackSpineToc, parseEpub2Ncx, parseEpub3Nav } from './nav.js';
import { deobfuscateEpubFont, parseEpubEncryptionXml } from './obfuscation.js';
import { parseContainerXml, parseOpfXml } from './opf.js';

function isImageMime(mime: string, path: string): boolean {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

async function resolveEpubCoverHref(
  zip: ZipArchive,
  candidates: readonly { readonly href: string; readonly mediaType: string }[],
  firstSpineHref: string | undefined,
): Promise<string | null> {
  for (const cand of candidates) {
    if (!zip.hasEntry(cand.href)) continue;
    if (isImageMime(cand.mediaType, cand.href)) {
      return cand.href;
    }
    if (/html|xml/i.test(cand.mediaType) || /\.(?:xhtml|html|htm)$/i.test(cand.href)) {
      const imgHref = await extractFirstImageFromXhtml(zip, cand.href);
      if (imgHref && zip.hasEntry(imgHref)) return imgHref;
    }
  }

  if (firstSpineHref && zip.hasEntry(firstSpineHref)) {
    const imgHref = await extractFirstImageFromXhtml(zip, firstSpineHref);
    if (imgHref && zip.hasEntry(imgHref)) return imgHref;
  }

  return null;
}

async function extractFirstImageFromXhtml(zip: ZipArchive, xhtmlPath: string): Promise<string | null> {
  try {
    const raw = await zip.readText(xhtmlPath, MAX_ENTRY_BYTES_MARKUP);
    const root = parseXhtmlOrHtml(raw);
    const imgNode = findFirst(root, (n) => {
      const t = localName(n.tag).toLowerCase();
      return t === 'img' || t === 'image';
    });
    if (!imgNode) return null;
    const rawSrc =
      getAttr(imgNode, 'src') ?? getAttr(imgNode, 'xlink:href') ?? getAttr(imgNode, 'href');
    if (!rawSrc) return null;
    const resolved = resolveArchiveHref(xhtmlPath, rawSrc);
    return resolved?.path ?? null;
  } catch {
    return null;
  }
}

interface ScannedSectionMeta {
  readonly anchors: ReadonlyMap<string, number>;
  readonly firstHeading: string | null;
  readonly countedChars: number;
}

function pickUsefulHeadTitle(headTitle: string, bookTitle: string): string | null {
  if (!headTitle) return null;
  if (headTitle.toLowerCase() === bookTitle.trim().toLowerCase()) return null;
  if (/project gutenberg ebook/i.test(headTitle)) return null;
  return headTitle;
}

/**
 * Parses and sanitizes an XHTML spine entry (without loading external CSS, since CSS never
 * alters `SectionText.text` or `[data-mb-skip]`) to extract exact `id -> countedCharOffset`
 * mappings and the section's first heading (`[P1-C2]` & `[P2]`).
 */
async function scanSectionAnchorsAndHeading(
  zip: ZipArchive,
  href: string,
  bookTitle: string,
  defaultLang: string | null,
  defaultDir: ReadingDirection,
): Promise<ScannedSectionMeta | null> {
  const entry = zip.findEntry(href);
  if (!entry) return null;
  try {
    const rawXhtml = await zip.readText(entry, MAX_ENTRY_BYTES_MARKUP);
    const docTree = parseXhtmlOrHtml(rawXhtml, false);
    const headTitleEl = findFirst(docTree, (n) => localName(n.tag).toLowerCase() === 'title');
    const rawHeadTitle = headTitleEl ? textContent(headTitleEl).replace(/\s+/g, ' ').trim() : '';

    const sanitized = await sanitizeDocument(docTree, {
      sectionPath: href,
      defaultLang,
      defaultDir,
    });

    const anchors = new Map<string, number>();
    let firstHeading: string | null = null;
    let firstShortBlock: string | null = null;
    let cursor = 0;

    const walk = (nodes: readonly MNode[]) => {
      for (const n of nodes) {
        if (n.type === 'text') {
          cursor += n.value.length;
          continue;
        }
        const idVal = n.attrs['id'];
        if (idVal && !anchors.has(idVal)) {
          anchors.set(idVal, cursor);
        }
        if ('data-mb-skip' in n.attrs) continue;
        if (!firstHeading && n.ns === 'xhtml' && /^h[1-6]$/.test(n.tag)) {
          const hText = textContent(n).replace(/\s+/g, ' ').trim();
          if (hText) firstHeading = hText;
        } else if (!firstShortBlock && n.ns === 'xhtml' && (n.tag === 'p' || n.tag === 'div')) {
          const bText = textContent(n).replace(/\s+/g, ' ').trim();
          if (bText && bText.length <= 60 && !/[。！？.!?]$/.test(bText)) {
            firstShortBlock = bText;
          }
        }
        walk(n.children);
      }
    };
    walk(sanitized.bodyChildren);

    return {
      anchors,
      firstHeading:
        firstHeading ?? pickUsefulHeadTitle(rawHeadTitle, bookTitle) ?? firstShortBlock ?? null,
      countedChars: cursor,
    };
  } catch {
    return null;
  }
}

function collectCoveredSections(items: readonly TocItem[], out = new Set<number>()): Set<number> {
  for (const item of items) {
    out.add(item.locator.section);
    if (item.children.length > 0) collectCoveredSections(item.children, out);
  }
  return out;
}

function collectFragmentSections(items: readonly TocItem[], out = new Set<number>()): Set<number> {
  for (const item of items) {
    if (item.href && item.href.includes('#')) {
      out.add(item.locator.section);
    }
    if (item.children.length > 0) collectFragmentSections(item.children, out);
  }
  return out;
}

function applyResolvedTocFragmentOffsets(
  items: readonly TocItem[],
  scannedBySection: ReadonlyMap<number, ScannedSectionMeta>,
): TocItem[] {
  return items.map((item) => {
    const children =
      item.children.length > 0
        ? applyResolvedTocFragmentOffsets(item.children, scannedBySection)
        : [];
    let locator = item.locator;
    if (item.href) {
      const hashIdx = item.href.indexOf('#');
      if (hashIdx >= 0) {
        const frag = safeDecodeUriComponent(item.href.slice(hashIdx + 1));
        const anchorOff = scannedBySection.get(item.locator.section)?.anchors.get(frag);
        if (anchorOff !== undefined) {
          locator = { section: item.locator.section, offset: anchorOff };
        }
      }
    }
    return {
      ...item,
      locator,
      children,
    };
  });
}

export async function buildEpubIndex(
  src: ByteSource,
  existingZip?: ZipArchive,
  options?: { readonly isInspect?: boolean },
): Promise<{
  readonly zip: ZipArchive;
  readonly index: EpubBookIndex;
}> {
  const isInspect = options?.isInspect ?? true;
  const zip = existingZip ?? (await ZipArchive.open(src));

  if (zip.hasEntry('META-INF/sinf.xml')) {
    throw new MiniBookError('drm-protected', 'This book is copy-protected (FairPlay DRM) and cannot be opened.');
  }

  const containerEntry = zip.findEntry('META-INF/container.xml');
  if (!containerEntry) {
    throw new MiniBookError('corrupt-book', 'EPUB is missing META-INF/container.xml');
  }
  const containerXml = await zip.readText(containerEntry, 512 * 1024);
  const opfPath = parseContainerXml(containerXml);

  const opfEntry = zip.findEntry(opfPath);
  if (!opfEntry) {
    throw new MiniBookError('corrupt-book', `EPUB OPF file not found at "${opfPath}"`);
  }
  const opfXml = await zip.readText(opfEntry, MAX_ENTRY_BYTES_MARKUP);

  const sizeMap = new Map<string, number>();
  for (const e of zip.entries) {
    sizeMap.set(normalizeArchivePath(e.name), e.uncompressedSize);
  }

  const parsedOpf = parseOpfXml(opfXml, opfPath, sizeMap);

  let obfuscatedFonts: EpubBookIndex['obfuscatedFonts'];
  const encEntry = zip.findEntry('META-INF/encryption.xml');
  if (encEntry) {
    const encXml = await zip.readText(encEntry, 2 * 1024 * 1024);
    const rules = parseEpubEncryptionXml(encXml, parsedOpf.uniqueIdentifiers);
    if (Object.keys(rules).length > 0) {
      obfuscatedFonts = rules;
    }
  }

  const hrefToSection = new Map<string, number>();
  for (const s of parsedOpf.spine) {
    if (s.href) {
      hrefToSection.set(normalizeArchivePath(s.href), s.index);
      hrefToSection.set(normalizeArchivePath(s.href).toLowerCase(), s.index);
    }
  }

  const resolveNavHref = (docPath: string, rawHref: string): Locator | null => {
    const res = resolveArchiveHref(docPath, rawHref);
    if (!res || !res.path) return null;
    const secIdx =
      hrefToSection.get(res.path) ?? hrefToSection.get(res.path.toLowerCase());
    if (secIdx === undefined) return null;
    return { section: secIdx, offset: 0 };
  };

  let toc: TocItem[] = [];
  if (parsedOpf.navHref && zip.hasEntry(parsedOpf.navHref)) {
    const navXml = await zip.readText(parsedOpf.navHref, MAX_ENTRY_BYTES_MARKUP);
    toc = parseEpub3Nav(navXml, parsedOpf.navHref, resolveNavHref);
  }
  if (toc.length === 0 && parsedOpf.ncxHref && zip.hasEntry(parsedOpf.ncxHref)) {
    const ncxXml = await zip.readText(parsedOpf.ncxHref, MAX_ENTRY_BYTES_MARKUP);
    toc = parseEpub2Ncx(ncxXml, parsedOpf.ncxHref, resolveNavHref);
  }

  const spineWithTitles: SectionRef[] = parsedOpf.spine.map((s) => ({ ...s }));
  const scannedMeta = new Map<number, ScannedSectionMeta>();

  // Pre-warm contiguous <= 1 MiB archive byte spans in `WindowedByteSource` so scanning
  // multiple XHTML entries during cold `openBook` costs <= 4 coalesced reads (`open <= 12` budget)!
  let coldPrefetchReadsUsed = 0;
  const prewarmedSections = new Set<number>();

  const prewarmSectionsForScan = async (secIndices: Iterable<number>): Promise<void> => {
    if (isInspect) {
      for (const idx of secIndices) prewarmedSections.add(idx);
      return;
    }

    const ranges: Array<{ secIdx: number; start: number; end: number }> = [];
    for (const secIdx of secIndices) {
      if (prewarmedSections.has(secIdx)) continue;
      const href = spineWithTitles[secIdx]?.href;
      const entry = href ? zip.findEntry(href) : undefined;
      if (!entry) continue;
      const start = entry.localHeaderOffset;
      const end = Math.min(src.size, entry.localHeaderOffset + 256 + entry.compressedSize);
      ranges.push({ secIdx, start, end });
    }
    if (ranges.length === 0) return;
    ranges.sort((a, b) => a.start - b.start);

    // Group nearby entries into <= 1 MiB coalesced window spans (max 4 spans, <= 2 MiB total so LRU retains all)
    let totalBytes = 0;
    let i = 0;
    while (i < ranges.length && coldPrefetchReadsUsed < 4 && totalBytes < 1792 * 1024) {
      const spanStart = ranges[i]!.start;
      let spanEnd = ranges[i]!.end;
      if (spanEnd - spanStart > 1024 * 1024) {
        i++;
        continue;
      }
      const batchSecs = [ranges[i]!.secIdx];
      let j = i + 1;
      while (j < ranges.length) {
        const candEnd = Math.max(spanEnd, ranges[j]!.end);
        if (candEnd - spanStart > 1024 * 1024 || ranges[j]!.start - spanEnd > 128 * 1024) {
          break;
        }
        spanEnd = candEnd;
        batchSecs.push(ranges[j]!.secIdx);
        j++;
      }
      if (totalBytes + (spanEnd - spanStart) > 1792 * 1024) break;
      await src.read(spanStart, spanEnd - spanStart);
      coldPrefetchReadsUsed++;
      totalBytes += spanEnd - spanStart;
      for (const sIdx of batchSecs) prewarmedSections.add(sIdx);
      i = j;
    }
  };

  const ensureScannedSection = async (secIdx: number): Promise<ScannedSectionMeta | null> => {
    const existing = scannedMeta.get(secIdx);
    if (existing) return existing;
    const href = spineWithTitles[secIdx]?.href;
    if (!href || (!isInspect && !prewarmedSections.has(secIdx))) return null;
    const scanned = await scanSectionAnchorsAndHeading(
      zip,
      href,
      parsedOpf.meta.title,
      parsedOpf.meta.language,
      parsedOpf.meta.direction,
    );
    if (scanned) scannedMeta.set(secIdx, scanned);
    return scanned;
  };

  // 1. Sparse TOC check (`[P2]`: e.g. Gutenberg zh EPUBs with 1 license TOC entry for 13 chapters)
  const linearSpine = spineWithTitles.filter((s) => s.linear);
  const coveredSections = collectCoveredSections(toc);
  const isSparseToc =
    toc.length === 0 || (linearSpine.length >= 2 && coveredSections.size < linearSpine.length * 0.5);

  if (isSparseToc) {
    await prewarmSectionsForScan(linearSpine.map((s) => s.index));
    const existingBySection = new Map<number, TocItem[]>();
    for (const item of toc) {
      const list = existingBySection.get(item.locator.section) ?? [];
      list.push(item);
      existingBySection.set(item.locator.section, list);
    }

    const rebuiltToc: TocItem[] = [];
    for (let idx = 0; idx < linearSpine.length; idx++) {
      const s = linearSpine[idx]!;
      const existingItems = existingBySection.get(s.index);
      if (existingItems && existingItems.length > 0) {
        rebuiltToc.push(...existingItems);
        continue;
      }
      const scanned = await ensureScannedSection(s.index);
      // Skip 0-char pure cover SVG wrappers when other sections exist
      if (scanned && scanned.countedChars === 0 && !scanned.firstHeading && linearSpine.length > 1) {
        continue;
      }
      const heading = scanned?.firstHeading ?? s.title ?? `Section ${idx + 1}`;
      spineWithTitles[s.index] = { ...s, title: heading };
      rebuiltToc.push({
        title: heading,
        locator: { section: s.index, offset: 0 },
        ...(s.href ? { href: s.href } : {}),
        children: [],
      });
    }
    toc = rebuiltToc.length > 0 ? rebuiltToc : buildFallbackSpineToc(spineWithTitles);
  }

  // 2. Resolve exact `#fragment` character offsets for TOC entries (`[P1-C2]`)
  const fragSections = collectFragmentSections(toc);
  if (fragSections.size > 0) {
    await prewarmSectionsForScan(fragSections);
    for (const secIdx of fragSections) {
      await ensureScannedSection(secIdx);
    }
    if (scannedMeta.size > 0) {
      toc = applyResolvedTocFragmentOffsets(toc, scannedMeta);
    }
  }

  // Propagate TOC titles onto matching spine refs
  const assignTitles = (items: readonly TocItem[]) => {
    for (const item of items) {
      const ref = spineWithTitles[item.locator.section];
      if (ref && !ref.title) {
        spineWithTitles[item.locator.section] = { ...ref, title: item.title };
      }
      if (item.children.length > 0) assignTitles(item.children);
    }
  };
  assignTitles(toc);

  const firstLinearHref =
    spineWithTitles.find((s) => s.linear)?.href ?? spineWithTitles[0]?.href;
  const coverHref = await resolveEpubCoverHref(
    zip,
    parsedOpf.coverCandidateHrefs,
    firstLinearHref,
  );

  const index: EpubBookIndex = {
    kind: 'epub',
    opfPath,
    entries: zip.entries,
    meta: parsedOpf.meta,
    toc,
    spine: spineWithTitles,
    manifest: parsedOpf.manifest,
    coverHref,
    ...(obfuscatedFonts ? { obfuscatedFonts } : {}),
  };

  return { zip, index };
}

export async function inspectEpub(src: ByteSource, existingZip?: ZipArchive): Promise<InspectedBook> {
  const { zip, index } = await buildEpubIndex(src, existingZip, { isInspect: true });
  let cover: CoverImage | null = null;
  if (index.coverHref && zip.hasEntry(index.coverHref)) {
    try {
      const bytes = await zip.readEntry(index.coverHref);
      const mime = mimeFromMagic(bytes, mimeFromPath(index.coverHref));
      cover = { bytes, mime };
    } catch {
      cover = null;
    }
  }
  return { meta: index.meta, cover, index };
}

export function createEpubSession(src: ByteSource, index: EpubBookIndex, preOpenedZip?: ZipArchive): BookSession {
  const zip = preOpenedZip ?? new ZipArchive(src, index.entries);
  const sheetCache = new LruCache<string, string>(16);
  const sectionCache = new LruCache<number, BuiltSectionUnits>(4);
  const anchorOffsetCache = new Map<number, Map<string, number>>();

  // Pre-seed known fragment offsets from `index.toc` so `resolveHref` works even before `loadSection`!
  const seedFromToc = (items: readonly TocItem[]) => {
    for (const item of items) {
      if (item.href) {
        const hashIdx = item.href.indexOf('#');
        if (hashIdx >= 0) {
          const frag = safeDecodeUriComponent(item.href.slice(hashIdx + 1));
          let secMap = anchorOffsetCache.get(item.locator.section);
          if (!secMap) {
            secMap = new Map<string, number>();
            anchorOffsetCache.set(item.locator.section, secMap);
          }
          if (!secMap.has(frag)) {
            secMap.set(frag, item.locator.offset);
          }
        }
      }
      if (item.children.length > 0) seedFromToc(item.children);
    }
  };
  seedFromToc(index.toc);

  const hrefToSection = new Map<string, number>();
  const mimeByHref = new Map<string, string>();
  for (const s of index.spine) {
    if (s.href) {
      hrefToSection.set(normalizeArchivePath(s.href), s.index);
      hrefToSection.set(normalizeArchivePath(s.href).toLowerCase(), s.index);
    }
  }
  for (const item of Object.values(index.manifest)) {
    mimeByHref.set(normalizeArchivePath(item.href), item.mediaType);
  }

  const loadSheet = async (archivePath: string): Promise<string | null> => {
    const norm = normalizeArchivePath(archivePath);
    const cached = sheetCache.get(norm);
    if (cached !== undefined) return cached;
    const entry = zip.findEntry(norm);
    if (!entry) return null;
    const text = await zip.readText(entry, MAX_ENTRY_BYTES_MARKUP);
    sheetCache.set(norm, text);
    return text;
  };

  const buildUnitsForSection = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const cached = sectionCache.get(sectionIndex);
    if (cached) return cached;

    const spineItem = index.spine[sectionIndex];
    if (!spineItem || !spineItem.href) {
      throw new MiniBookError('not-found', `EPUB spine section ${sectionIndex} not found`);
    }

    const rawXhtml = await zip.readText(spineItem.href, MAX_ENTRY_BYTES_MARKUP);
    const docTree = parseXhtmlOrHtml(rawXhtml, false);

    const sanitized = await sanitizeDocument(docTree, {
      sectionPath: spineItem.href,
      defaultLang: index.meta.language,
      defaultDir: index.meta.direction,
      loadSheet,
      resolveLinkHref: (rawHref, secPath) => {
        const extMatch = /^(?:https?:|mailto:)/i.test(rawHref.trim());
        if (extMatch) return { external: rawHref.trim() };
        if (rawHref.trim().startsWith('//')) return { external: `https:${rawHref.trim()}` };
        const res = resolveArchiveHref(secPath, rawHref);
        if (!res || !res.path) return null;
        const targetSec =
          hrefToSection.get(res.path) ?? hrefToSection.get(res.path.toLowerCase());
        if (targetSec === undefined) return null;
        return {
          loc: res.fragment ? `${targetSec}#${res.fragment}` : `${targetSec}:0`,
        };
      },
    });

    const anchorOffsets = new Map<string, number>();
    let cursor = 0;
    const walkAnchors = (nodes: typeof sanitized.bodyChildren) => {
      for (const n of nodes) {
        if (n.type === 'text') {
          cursor += n.value.length;
          continue;
        }
        const idVal = n.attrs['id'];
        if (idVal && !anchorOffsets.has(idVal)) {
          anchorOffsets.set(idVal, cursor);
        }
        if ('data-mb-skip' in n.attrs) continue;
        walkAnchors(n.children);
      }
    };
    walkAnchors(sanitized.bodyChildren);
    anchorOffsetCache.set(sectionIndex, anchorOffsets);

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
      const built = await buildUnitsForSection(sectionIndex);
      const clamped = Math.max(0, Math.min(built.units.length - 1, unitIndex));
      return built.units[clamped]!;
    },

    async loadSectionUnits(sectionIndex: number): Promise<readonly SectionDoc[]> {
      const built = await buildUnitsForSection(sectionIndex);
      return built.units;
    },

    async loadSectionText(sectionIndex: number): Promise<SectionText> {
      const built = await buildUnitsForSection(sectionIndex);
      return built.fullText;
    },

    async loadResource(href: string): Promise<BookResource> {
      const cleanPath = normalizeArchivePath(href.split('#')[0]!);
      let bytes = await zip.readEntry(cleanPath);
      const obfRule = index.obfuscatedFonts?.[cleanPath];
      if (obfRule) {
        bytes = deobfuscateEpubFont(bytes, obfRule);
      }
      const declaredMime = mimeByHref.get(cleanPath) ?? mimeFromPath(cleanPath);
      const mime = declaredMime === 'application/octet-stream' ? mimeFromMagic(bytes, declaredMime) : declaredMime;
      return { bytes, mime };
    },

    resolveHref(fromSection: number, href: string): ResolvedHref {
      const trimmed = href.trim();
      if (!trimmed) return null;
      if (/^(?:https?:|mailto:)/i.test(trimmed)) {
        return { external: trimmed };
      }
      if (trimmed.startsWith('//')) {
        return { external: `https:${trimmed}` };
      }
      const mbLocMatch = /^(\d+)(?::(\d+)|#(.+))?$/.exec(trimmed);
      if (mbLocMatch) {
        const sec = Number.parseInt(mbLocMatch[1]!, 10);
        if (sec < 0 || sec >= index.spine.length) return null;
        if (mbLocMatch[2] !== undefined) {
          return { section: sec, offset: Number.parseInt(mbLocMatch[2], 10) };
        }
        const frag = mbLocMatch[3];
        const off = frag ? (anchorOffsetCache.get(sec)?.get(frag) ?? 0) : 0;
        return { section: sec, offset: off };
      }

      const baseHref = index.spine[fromSection]?.href ?? index.opfPath;
      const resolved = resolveArchiveHref(baseHref, trimmed);
      if (!resolved || !resolved.path) return null;
      const targetSec =
        hrefToSection.get(resolved.path) ?? hrefToSection.get(resolved.path.toLowerCase());
      if (targetSec === undefined) return null;
      const offset = resolved.fragment
        ? (anchorOffsetCache.get(targetSec)?.get(resolved.fragment) ?? 0)
        : 0;
      return { section: targetSec, offset };
    },

    async cover(): Promise<CoverImage | null> {
      if (!index.coverHref || !zip.hasEntry(index.coverHref)) return null;
      try {
        const bytes = await zip.readEntry(index.coverHref);
        const mime = mimeFromMagic(bytes, mimeByHref.get(index.coverHref) ?? mimeFromPath(index.coverHref));
        return { bytes, mime };
      } catch {
        return null;
      }
    },

    close(): void {
      sheetCache.clear();
      sectionCache.clear();
      anchorOffsetCache.clear();
    },
  };
}
