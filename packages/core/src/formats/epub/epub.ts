import { sanitizeDocument } from '../../book/sanitize.js';
import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { MAX_ENTRY_BYTES_MARKUP, ZipArchive } from '../../io/zip.js';
import { parseXhtmlOrHtml } from '../../markup/html.js';
import { findFirst, getAttr, localName } from '../../markup/mnode.js';
import type {
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  EpubBookIndex,
  InspectedBook,
  Locator,
  ResolvedHref,
  SectionDoc,
  SectionText,
  TocItem,
} from '../../types.js';
import { LruCache } from '../../util/lru.js';
import {
  mimeFromMagic,
  mimeFromPath,
  normalizeArchivePath,
  resolveArchiveHref,
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
    // Guide cover pointing to an XHTML wrapper page -> extract its first `<img>` or SVG `<image>`
    if (/html|xml/i.test(cand.mediaType) || /\.(?:xhtml|html|htm)$/i.test(cand.href)) {
      const imgHref = await extractFirstImageFromXhtml(zip, cand.href);
      if (imgHref && zip.hasEntry(imgHref)) return imgHref;
    }
  }

  // Fallback #4 (`ARCHITECTURE.md` §4.3 #4): first image of the first spine item
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

export async function buildEpubIndex(src: ByteSource, existingZip?: ZipArchive): Promise<{
  readonly zip: ZipArchive;
  readonly index: EpubBookIndex;
}> {
  const zip = existingZip ?? (await ZipArchive.open(src));

  // FairPlay DRM guard (`META-INF/sinf.xml`)
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

  // Check `META-INF/encryption.xml` for font obfuscation vs DRM (`§4.3 #5`)
  let obfuscatedFonts: EpubBookIndex['obfuscatedFonts'];
  const encEntry = zip.findEntry('META-INF/encryption.xml');
  if (encEntry) {
    const encXml = await zip.readText(encEntry, 2 * 1024 * 1024);
    const rules = parseEpubEncryptionXml(encXml, parsedOpf.uniqueIdentifiers);
    if (Object.keys(rules).length > 0) {
      obfuscatedFonts = rules;
    }
  }

  // Map archive path -> spine section index
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
  if (toc.length === 0) {
    toc = buildFallbackSpineToc(parsedOpf.spine);
  }

  // Propagate top-level TOC titles onto matching spine refs for crisp chapter captions
  const spineWithTitles = parsedOpf.spine.map((s) => ({ ...s }));
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
  const { zip, index } = await buildEpubIndex(src, existingZip);
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
  const anchorOffsetCache = new Map<number, ReadonlyMap<string, number>>();

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

    // Record exact counted-text character offsets of `id="..."` anchors inside this section!
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
      // Handle already-encoded `data-mb-loc` strings (`"2:150"` or `"2#note1"`)
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
