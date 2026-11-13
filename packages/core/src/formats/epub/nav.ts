import { parseXhtmlOrHtml } from '../../markup/html.js';
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
import type { Locator, SectionRef, TocItem } from '../../types.js';
import { resolveArchiveHref } from '../../util/path.js';

export type HrefToLocatorFn = (docPath: string, rawHref: string) => Locator | null;

/**
 * Parses an EPUB 3 Navigation Document (`<nav epub:type="toc">`, nested `<ol><li>`).
 */
export function parseEpub3Nav(
  navSource: string,
  navPath: string,
  resolveToLocator: HrefToLocatorFn,
): TocItem[] {
  const root = parseXhtmlOrHtml(navSource);
  const navElements = findAll(root, (n) => localName(n.tag).toLowerCase() === 'nav');
  const tocNav =
    navElements.find((n) => {
      const epubType = (getAttr(n, 'epub:type') ?? '').toLowerCase().split(/\s+/);
      const role = (getAttr(n, 'role') ?? '').toLowerCase().trim();
      return epubType.includes('toc') || role === 'doc-toc';
    }) ?? navElements[0];

  if (!tocNav) return [];

  const topOl = findFirst(tocNav, (n) => localName(n.tag).toLowerCase() === 'ol');
  if (!topOl) return [];

  const parseOl = (olNode: MElement): TocItem[] => {
    const items: TocItem[] = [];
    for (const li of childElements(olNode, 'li')) {
      const linkOrSpan = li.children.find(
        (c): c is MElement =>
          c.type === 'element' &&
          (localName(c.tag).toLowerCase() === 'a' || localName(c.tag).toLowerCase() === 'span'),
      );
      const nestedOl = childElements(li, 'ol')[0];
      const children = nestedOl ? parseOl(nestedOl) : [];
      const title = linkOrSpan ? textContent(linkOrSpan).replace(/\s+/g, ' ').trim() : '';
      const rawHref = linkOrSpan && localName(linkOrSpan.tag).toLowerCase() === 'a'
        ? getAttr(linkOrSpan, 'href')?.trim()
        : undefined;

      let locator: Locator | null = null;
      let normalizedHref: string | undefined;
      if (rawHref) {
        locator = resolveToLocator(navPath, rawHref);
        const res = resolveArchiveHref(navPath, rawHref);
        if (res?.path) {
          normalizedHref = res.fragment ? `${res.path}#${res.fragment}` : res.path;
        }
      }
      if (!locator && children.length > 0) {
        locator = children[0]!.locator;
      }
      if (!title || !locator) continue;

      items.push({
        title,
        locator,
        ...(normalizedHref !== undefined ? { href: normalizedHref } : {}),
        children,
      });
    }
    return items;
  };

  return parseOl(topOl);
}

/**
 * Parses an EPUB 2 NCX (`<navMap>` nested `<navPoint>`, ignoring `playOrder` per `§4.3 #3`).
 */
export function parseEpub2Ncx(
  ncxSource: string,
  ncxPath: string,
  resolveToLocator: HrefToLocatorFn,
): TocItem[] {
  const root = parseXml(ncxSource, { strict: false });
  const navMap = findFirst(root, (n) => localName(n.tag).toLowerCase() === 'navmap');
  if (!navMap) return [];

  const parseNavPoints = (parent: MElement): TocItem[] => {
    const out: TocItem[] = [];
    for (const np of childElements(parent, 'navpoint')) {
      const labelEl = childElements(np, 'navlabel')[0];
      const textEl = labelEl ? childElements(labelEl, 'text')[0] : undefined;
      const title = (textEl ? textContent(textEl) : '').replace(/\s+/g, ' ').trim();

      const contentEl = childElements(np, 'content')[0];
      const rawSrc = contentEl ? getAttr(contentEl, 'src')?.trim() : undefined;
      const children = parseNavPoints(np);

      let locator: Locator | null = null;
      let normalizedHref: string | undefined;
      if (rawSrc) {
        locator = resolveToLocator(ncxPath, rawSrc);
        const res = resolveArchiveHref(ncxPath, rawSrc);
        if (res?.path) {
          normalizedHref = res.fragment ? `${res.path}#${res.fragment}` : res.path;
        }
      }
      if (!locator && children.length > 0) {
        locator = children[0]!.locator;
      }
      if (!title || !locator) continue;

      out.push({
        title,
        locator,
        ...(normalizedHref !== undefined ? { href: normalizedHref } : {}),
        children,
      });
    }
    return out;
  };

  return parseNavPoints(navMap);
}

export function buildFallbackSpineToc(spine: readonly SectionRef[]): TocItem[] {
  const linear = spine.filter((s) => s.linear);
  const source = linear.length > 0 ? linear : spine;
  return source.map((s, idx) => ({
    title: s.title || `Section ${idx + 1}`,
    locator: { section: s.index, offset: 0 },
    ...(s.href ? { href: s.href } : {}),
    children: [],
  }));
}
