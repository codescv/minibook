import { MiniBookError } from '../../errors.js';
import {
  childElements,
  findAll,
  findFirst,
  getAttr,
  localName,
  type MElement,
  textContent,
} from '../../markup/mnode.js';
import { parseXml } from '../../markup/xml-tokenizer.js';
import type { BookMeta, EpubManifestItem, ReadingDirection, SectionRef } from '../../types.js';
import { normalizeArchivePath, resolveArchiveHref } from '../../util/path.js';

export function parseContainerXml(containerXml: string): string {
  const root = parseXml(containerXml, { strict: false });
  const rootfiles = findAll(root, (n) => localName(n.tag).toLowerCase() === 'rootfile');
  const preferred =
    rootfiles.find(
      (rf) => (getAttr(rf, 'media-type') ?? '').trim().toLowerCase() === 'application/oebps-package+xml',
    ) ?? rootfiles[0];

  const fullPath = preferred ? getAttr(preferred, 'full-path')?.trim() : undefined;
  if (!fullPath) {
    throw new MiniBookError('corrupt-book', 'EPUB container.xml contains no OPF rootfile path');
  }
  return normalizeArchivePath(fullPath);
}

export interface ParsedOpf {
  readonly meta: BookMeta;
  readonly uniqueIdentifiers: readonly string[];
  readonly manifest: Record<string, EpubManifestItem>;
  readonly manifestByHref: Record<string, EpubManifestItem>;
  readonly spine: SectionRef[];
  readonly spineItemIds: readonly string[];
  readonly navHref: string | null;
  readonly ncxHref: string | null;
  readonly coverCandidateHrefs: readonly { readonly href: string; readonly mediaType: string }[];
}

export function parseOpfXml(
  opfXml: string,
  opfPath: string,
  entrySizesByPath: ReadonlyMap<string, number>,
): ParsedOpf {
  const pkg = parseXml(opfXml, { strict: false });
  const metadataEl = findFirst(pkg, (n) => localName(n.tag).toLowerCase() === 'metadata');
  const manifestEl = findFirst(pkg, (n) => localName(n.tag).toLowerCase() === 'manifest');
  const spineEl = findFirst(pkg, (n) => localName(n.tag).toLowerCase() === 'spine');
  const guideEl = findFirst(pkg, (n) => localName(n.tag).toLowerCase() === 'guide');

  if (!manifestEl || !spineEl) {
    throw new MiniBookError('corrupt-book', 'EPUB OPF missing <manifest> or <spine>');
  }

  // Collect EPUB 3 `<meta refines="#id" property="...">` refinements
  const refinesMap = new Map<string, Map<string, string>>();
  let fixedLayout = false;
  let metaCoverContent: string | null = null;

  if (metadataEl) {
    for (const m of findAll(metadataEl, (n) => localName(n.tag).toLowerCase() === 'meta')) {
      const prop = getAttr(m, 'property')?.trim().toLowerCase();
      const refines = getAttr(m, 'refines')?.trim();
      const name = getAttr(m, 'name')?.trim().toLowerCase();
      const content = getAttr(m, 'content')?.trim();
      const val = textContent(m).trim();

      if (refines && refines.startsWith('#') && prop) {
        const targetId = refines.slice(1);
        let props = refinesMap.get(targetId);
        if (!props) {
          props = new Map();
          refinesMap.set(targetId, props);
        }
        props.set(prop, val);
      }

      if (prop === 'rendition:layout' && val.toLowerCase() === 'pre-paginated') {
        fixedLayout = true;
      }
      if (name === 'fixed-layout' && content?.toLowerCase() === 'true') {
        fixedLayout = true;
      }
      if (name === 'cover' && content) {
        metaCoverContent = content;
      }
    }
  }

  // Extract Dublin Core metadata (`dc:title`, `dc:creator`, `dc:language`, `dc:identifier`, ...)
  let mainTitle = '';
  let fallbackTitle = '';
  const authors: string[] = [];
  let language: string | null = null;
  const uniqueIdAttr = getAttr(pkg, 'unique-identifier')?.trim();
  let primaryIdentifier: string | null = null;
  const allIdentifiers: string[] = [];
  let description: string | undefined;
  let publisher: string | undefined;
  let publishedAt: string | undefined;

  if (metadataEl) {
    for (const child of metadataEl.children) {
      if (child.type !== 'element') continue;
      const loc = localName(child.tag).toLowerCase();
      const val = textContent(child).trim();
      if (!val) continue;
      const id = getAttr(child, 'id')?.trim();
      const refines = id ? refinesMap.get(id) : undefined;

      if (loc === 'title') {
        if (!fallbackTitle) fallbackTitle = val;
        if (refines?.get('title-type')?.toLowerCase() === 'main') {
          mainTitle = val;
        }
      } else if (loc === 'creator') {
        const role = (refines?.get('role') ?? getAttr(child, 'opf:role') ?? 'aut').toLowerCase();
        if (role === 'aut' || role === 'author' || authors.length === 0) {
          authors.push(val);
        }
      } else if (loc === 'language' && !language) {
        language = val;
      } else if (loc === 'identifier') {
        if (uniqueIdAttr && id === uniqueIdAttr) {
          primaryIdentifier = val;
          allIdentifiers.unshift(val);
        } else {
          if (!primaryIdentifier) primaryIdentifier = val;
          allIdentifiers.push(val);
        }
      } else if (loc === 'description' && !description) {
        description = val;
      } else if (loc === 'publisher' && !publisher) {
        publisher = val;
      } else if (loc === 'date' && !publishedAt) {
        publishedAt = val;
      }
    }
  }

  const title = mainTitle || fallbackTitle || fallbackTitleFromPath(opfPath);

  // Parse `<manifest>`
  const manifest: Record<string, EpubManifestItem> = {};
  const manifestByHref: Record<string, EpubManifestItem> = {};
  let navHref: string | null = null;
  let ncxByMime: string | null = null;
  let propCoverItem: EpubManifestItem | null = null;

  for (const itemEl of childElements(manifestEl, 'item')) {
    const id = getAttr(itemEl, 'id')?.trim();
    const rawHref = getAttr(itemEl, 'href')?.trim();
    const mediaType = (getAttr(itemEl, 'media-type') ?? 'application/octet-stream').trim();
    if (!id || !rawHref) continue;

    const resolved = resolveArchiveHref(opfPath, rawHref);
    if (!resolved || !resolved.path) continue;

    const rawProps = getAttr(itemEl, 'properties')?.trim();
    const properties = rawProps ? rawProps.split(/\s+/).filter(Boolean) : undefined;
    const item: EpubManifestItem = {
      id,
      href: resolved.path,
      mediaType,
      ...(properties ? { properties } : {}),
    };
    manifest[id] = item;
    manifestByHref[resolved.path] = item;

    if (properties?.includes('nav') && !navHref) {
      navHref = resolved.path;
    }
    if (properties?.includes('cover-image') && !propCoverItem) {
      propCoverItem = item;
    }
    if (mediaType.toLowerCase() === 'application/x-dtbncx+xml' && !ncxByMime) {
      ncxByMime = resolved.path;
    }
  }

  // Parse `<spine>`
  const rawDir = (getAttr(spineEl, 'page-progression-direction') ?? 'ltr').trim().toLowerCase();
  const direction: ReadingDirection = rawDir === 'rtl' ? 'rtl' : 'ltr';
  const spineTocId = getAttr(spineEl, 'toc')?.trim();
  const ncxHref = (spineTocId && manifest[spineTocId]?.href) ?? ncxByMime;

  const spine: SectionRef[] = [];
  const spineItemIds: string[] = [];

  for (const itemref of childElements(spineEl, 'itemref')) {
    const idref = getAttr(itemref, 'idref')?.trim();
    if (!idref) continue;
    const mItem = manifest[idref];
    if (!mItem) continue;

    const linearAttr = (getAttr(itemref, 'linear') ?? 'yes').trim().toLowerCase();
    const linear = linearAttr !== 'no';
    const rawProps = getAttr(itemref, 'properties') ?? '';
    if (rawProps.includes('rendition:layout-pre-paginated')) {
      fixedLayout = true;
    }

    const byteSize = entrySizesByPath.get(mItem.href) ?? 4096;
    const idx = spine.length;
    spine.push({
      index: idx,
      id: idref,
      href: mItem.href,
      linear,
      sizeHint: Math.max(64, Math.floor(byteSize * 0.65)),
    });
    spineItemIds.push(idref);
  }

  if (spine.length === 0) {
    throw new MiniBookError('corrupt-book', 'EPUB <spine> contains zero valid manifest items');
  }

  // Cover candidate priority (`ARCHITECTURE.md` §4.3 #4):
  //   1. `manifest` `properties~="cover-image"`
  //   2. `<meta name="cover" content="..."/>`
  //   3. `<guide><reference type="cover" href="..."/></guide>`
  const coverCandidateHrefs: Array<{ href: string; mediaType: string }> = [];
  if (propCoverItem) {
    coverCandidateHrefs.push({ href: propCoverItem.href, mediaType: propCoverItem.mediaType });
  }
  if (metaCoverContent) {
    const byId = manifest[metaCoverContent];
    if (byId) {
      coverCandidateHrefs.push({ href: byId.href, mediaType: byId.mediaType });
    } else {
      const resolvedMeta = resolveArchiveHref(opfPath, metaCoverContent);
      if (resolvedMeta?.path) {
        const byHref = manifestByHref[resolvedMeta.path];
        coverCandidateHrefs.push({
          href: resolvedMeta.path,
          mediaType: byHref?.mediaType ?? 'image/jpeg',
        });
      }
    }
  }
  if (guideEl) {
    for (const ref of childElements(guideEl, 'reference')) {
      const refType = (getAttr(ref, 'type') ?? '').trim().toLowerCase();
      const refHref = getAttr(ref, 'href')?.trim();
      if (refType === 'cover' && refHref) {
        const resolvedGuide = resolveArchiveHref(opfPath, refHref);
        if (resolvedGuide?.path) {
          const m = manifestByHref[resolvedGuide.path];
          coverCandidateHrefs.push({
            href: resolvedGuide.path,
            mediaType: m?.mediaType ?? 'application/xhtml+xml',
          });
        }
      }
    }
  }

  const meta: BookMeta = {
    title,
    authors,
    language,
    identifier: primaryIdentifier,
    format: 'epub',
    direction,
    fixedLayout,
    ...(description !== undefined ? { description } : {}),
    ...(publisher !== undefined ? { publisher } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };

  return {
    meta,
    uniqueIdentifiers: allIdentifiers,
    manifest,
    manifestByHref,
    spine,
    spineItemIds,
    navHref,
    ncxHref,
    coverCandidateHrefs,
  };
}

function fallbackTitleFromPath(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1]?.replace(/\.[^.]+$/, '') || 'Untitled';
}
