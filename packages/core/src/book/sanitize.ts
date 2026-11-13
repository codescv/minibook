import { sanitizeXmlChars } from '../markup/entities.js';
import {
  el,
  findAll,
  findFirst,
  getAttr,
  localName,
  type MElement,
  type MNamespace,
  type MNode,
  textContent,
  txt,
} from '../markup/mnode.js';
import type { ReadingDirection } from '../types.js';
import {
  isRemoteOrExternalScheme,
  isSafeDataImageUri,
  resolveArchiveHref,
} from '../util/path.js';
import { type CssSanitizeOptions, sanitizeInlineStyle, sanitizeStylesheet } from './css.js';

// Dropped WITH their entire subtree (`ARCHITECTURE.md` §5.2)
const DROP_WITH_CONTENT_XHTML = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'option',
  'optgroup',
  'fieldset',
  'datalist',
  'output',
  'audio',
  'video',
  'canvas',
  'template',
  'noscript',
  'link',
  'meta',
  'base',
  'frame',
  'frameset',
  'head',
  'style',
  'title',
  'param',
  'source',
  'track',
]);

const DROP_WITH_CONTENT_SVG = new Set([
  'script',
  'foreignobject',
  'animate',
  'animatemotion',
  'animatetransform',
  'animatecolor',
  'set',
  'mpath',
  'handler',
  'listener',
  'iframe',
  'audio',
  'video',
]);

const ALLOWED_XHTML_TAGS = new Set([
  'div',
  'section',
  'article',
  'aside',
  'nav',
  'header',
  'footer',
  'main',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
  'br',
  'wbr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
  'span',
  'a',
  'em',
  'strong',
  'i',
  'b',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'code',
  'kbd',
  'samp',
  'var',
  'cite',
  'q',
  'dfn',
  'abbr',
  'time',
  'bdi',
  'bdo',
  'ruby',
  'rb',
  'rt',
  'rp',
  'rtc',
  'img',
  'picture',
  'details',
  'summary',
]);

const ALLOWED_SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'image',
  'title',
  'desc',
  'defs',
  'use',
  'symbol',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
]);

const ALLOWED_MATH_TAGS = new Set([
  'math',
  'mrow',
  'mi',
  'mn',
  'mo',
  'mtext',
  'mspace',
  'ms',
  'mfrac',
  'msqrt',
  'mroot',
  'mstyle',
  'merror',
  'mpadded',
  'mphantom',
  'mfenced',
  'menclose',
  'msub',
  'msup',
  'msubsup',
  'munder',
  'mover',
  'munderover',
  'mmultiscripts',
  'mprescripts',
  'none',
  'mtable',
  'mtr',
  'mtd',
  'semantics',
  'annotation',
]);

const ALLOWED_HTML_ATTRS = new Set([
  'id',
  'class',
  'lang',
  'xml:lang',
  'dir',
  'title',
  'alt',
  'colspan',
  'rowspan',
  'width',
  'height',
  'epub:type',
  'role',
  'style',
  'href',
  'src',
]);

const ALLOWED_SVG_ATTRS = new Set([
  ...ALLOWED_HTML_ATTRS,
  'xlink:href',
  'viewBox',
  'preserveAspectRatio',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'dx',
  'dy',
  'points',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'transform',
  'opacity',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'clipPathUnits',
  'clip-path',
  'mask',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
]);

const ALLOWED_MATH_ATTRS = new Set([
  ...ALLOWED_HTML_ATTRS,
  'display',
  'mathvariant',
  'stretchy',
  'fence',
  'separator',
  'accent',
  'accentunder',
  'linethickness',
  'columnalign',
  'rowalign',
  'columnspacing',
  'rowspacing',
  'scriptlevel',
  ' movablelimits',
]);

const BRACKETED_OR_SYMBOL_NOTEREF =
  /^\s*(?:\[\s*\d{1,4}\s*\]|\(\s*\d{1,4}\s*\)|\{\s*\d{1,4}\s*\}|［\s*\d{1,4}\s*］|（\s*\d{1,4}\s*）|〔\s*\d{1,4}\s*〕|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|[*†‡§¶※]+|注\s*\d{1,4})\s*$/;
const BARE_DIGIT_NOTEREF = /^\s*\d{1,4}\s*$/;

export interface SanitizeDocumentOptions {
  /** Archive path of the current XHTML section (e.g. `OEBPS/Text/ch1.xhtml`). */
  readonly sectionPath: string;
  /** Default book language if `<html>`/`<body>` has no `lang`. */
  readonly defaultLang?: string | null;
  /** Default reading direction if `<html>`/`<body>` has no `dir`. */
  readonly defaultDir?: ReadingDirection;
  /** Loader for linked `<link rel="stylesheet">` and `@import` files. */
  readonly loadSheet?: (archivePath: string) => Promise<string | null>;
  /** Custom resource URL resolver (defaults to `mb-res:<resolvedArchivePath>`). */
  readonly resolveResourceUrl?: CssSanitizeOptions['resolveResourceUrl'];
  /**
   * Resolves internal `<a href="...">` targets to a `data-mb-loc` token
   * (e.g. `"2#fn1"` or `"2:0"`). Return `null` to drop an invalid/unsafe link.
   */
  readonly resolveLinkHref?: (rawHref: string, sectionPath: string) => { loc?: string; external?: string } | null;
}

export interface SanitizedDocumentResult {
  readonly bodyChildren: MNode[];
  readonly css: string;
  readonly lang: string | null;
  readonly dir: ReadingDirection;
  readonly resources: string[];
  readonly isCoverLike: boolean;
}

function hasToken(attrValue: string | undefined, token: string): boolean {
  if (!attrValue) return false;
  return attrValue
    .toLowerCase()
    .split(/\s+/)
    .includes(token);
}

function shouldMarkSkip(node: MElement, insideSup: boolean): boolean {
  if (node.ns !== 'xhtml') {
    return getAttr(node, 'aria-hidden')?.toLowerCase() === 'true';
  }
  const tag = node.tag.toLowerCase();
  if (tag === 'rt' || tag === 'rp') return true;

  const epubType = getAttr(node, 'epub:type');
  if (hasToken(epubType, 'noteref') || hasToken(epubType, 'pagebreak')) {
    return true;
  }

  const role = getAttr(node, 'role')?.toLowerCase().trim();
  if (role === 'doc-noteref' || role === 'doc-pagebreak') {
    return true;
  }

  if (getAttr(node, 'aria-hidden')?.toLowerCase() === 'true') {
    return true;
  }

  if (tag === 'sup') {
    const raw = textContent(node);
    if (BRACKETED_OR_SYMBOL_NOTEREF.test(raw) || BARE_DIGIT_NOTEREF.test(raw)) {
      return true;
    }
  }

  if (tag === 'a') {
    const raw = textContent(node);
    if (BRACKETED_OR_SYMBOL_NOTEREF.test(raw)) {
      return true;
    }
    if ((insideSup || Boolean(getAttr(node, 'href'))) && BARE_DIGIT_NOTEREF.test(raw)) {
      const href = getAttr(node, 'href') ?? '';
      if (insideSup || href.includes('#') || /note|fn|foot/i.test(href)) {
        return true;
      }
    }
  }

  return false;
}

function defaultResolveLinkHref(
  rawHref: string,
  sectionPath: string,
): { loc?: string; external?: string } | null {
  const ext = isRemoteOrExternalScheme(rawHref);
  if (ext) return { external: ext };
  const resolved = resolveArchiveHref(sectionPath, rawHref);
  if (!resolved) return null;
  const target = resolved.fragment ? `${resolved.path}#${resolved.fragment}` : resolved.path;
  return { loc: target };
}

function defaultResolveResourceUrl(
  rawUrl: string,
  basePath: string,
): { placeholder: string; resourcePath?: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  if (isSafeDataImageUri(trimmed)) {
    return { placeholder: trimmed };
  }
  const resolved = resolveArchiveHref(basePath, trimmed);
  if (!resolved || !resolved.path) return null;
  const suffix = resolved.fragment ? `#${resolved.fragment}` : '';
  return {
    placeholder: `mb-res:${resolved.path}${suffix}`,
    resourcePath: resolved.path,
  };
}

/**
 * Allowlist DOM-free sanitizer (`ARCHITECTURE.md` §5.2, §5.3):
 *   - Extracts & sanitizes linked stylesheets against their OWN archive paths and inline `<style>`
 *     blocks against `sectionPath`.
 *   - Strips `<script>`, `<iframe>`, event handlers (`on*`), `javascript:`, `srcdoc`, remote URLs.
 *   - Marks skipped elements (`rt`, `rp`, `noteref`, `pagebreak`, `aria-hidden`, footnote `sup`/`a`)
 *     with `data-mb-skip=""`.
 *   - Normalizes all surviving `MText` nodes with `sanitizeXmlChars` so `SectionText.text` and
 *     serialized XHTML match 1-to-1 (`I-TEXT` invariant).
 */
export async function sanitizeDocument(
  docRoot: MElement,
  options: SanitizeDocumentOptions,
): Promise<SanitizedDocumentResult> {
  const resources = new Set<string>();
  const resourceResolver = options.resolveResourceUrl ?? defaultResolveResourceUrl;
  const linkResolver = options.resolveLinkHref ?? defaultResolveLinkHref;

  // 1. Extract `lang` and `dir` from `<html>` / `<body>`
  const htmlEl = localName(docRoot.tag).toLowerCase() === 'html'
    ? docRoot
    : findFirst(docRoot, (n) => localName(n.tag).toLowerCase() === 'html');
  const bodyEl = findFirst(docRoot, (n) => n.ns === 'xhtml' && localName(n.tag).toLowerCase() === 'body') ?? docRoot;

  const rawLang =
    getAttr(bodyEl, 'lang') ??
    getAttr(bodyEl, 'xml:lang') ??
    (htmlEl ? getAttr(htmlEl, 'lang') ?? getAttr(htmlEl, 'xml:lang') : undefined) ??
    options.defaultLang ??
    null;
  const lang = rawLang ? rawLang.trim() || null : null;

  const rawDir = (
    getAttr(bodyEl, 'dir') ??
    (htmlEl ? getAttr(htmlEl, 'dir') : undefined) ??
    ''
  )
    .trim()
    .toLowerCase();
  const dir: ReadingDirection =
    rawDir === 'rtl' ? 'rtl' : rawDir === 'ltr' ? 'ltr' : (options.defaultDir ?? 'ltr');

  // 2. Collect linked `<link rel="stylesheet" href="...">` and inline `<style>` in document order
  const styleNodes = findAll(docRoot, (n) => {
    if (n.ns !== 'xhtml') return false;
    const t = localName(n.tag).toLowerCase();
    if (t === 'style') return true;
    if (t === 'link') {
      const rel = getAttr(n, 'rel') ?? '';
      return hasToken(rel, 'stylesheet');
    }
    return false;
  });

  const cssBlocks: string[] = [];
  for (const sn of styleNodes) {
    const t = localName(sn.tag).toLowerCase();
    if (t === 'link') {
      const href = getAttr(sn, 'href');
      if (!href || !options.loadSheet) continue;
      const resolved = resolveArchiveHref(options.sectionPath, href);
      if (!resolved || !resolved.path) continue; // Remote `<link rel="stylesheet">` dropped!
      const rawCss = await options.loadSheet(resolved.path);
      if (!rawCss) continue;
      const sanitized = await sanitizeStylesheet(rawCss, {
        basePath: resolved.path, // CRITICAL: resolve `url()`/`@import` against stylesheet's own path!
        ...(options.loadSheet ? { loadSheet: options.loadSheet } : {}),
        resolveResourceUrl: resourceResolver,
        resources,
      });
      if (sanitized) cssBlocks.push(sanitized);
    } else if (t === 'style') {
      const rawCss = textContent(sn);
      if (!rawCss.trim()) continue;
      const sanitized = await sanitizeStylesheet(rawCss, {
        basePath: options.sectionPath,
        ...(options.loadSheet ? { loadSheet: options.loadSheet } : {}),
        resolveResourceUrl: resourceResolver,
        resources,
      });
      if (sanitized) cssBlocks.push(sanitized);
    }
  }

  // 3. Sanitize body subtree into clean `MNode[]`
  const sanitizeChildren = (children: readonly MNode[], parentNs: MNamespace, insideSup: boolean): MNode[] => {
    const out: MNode[] = [];
    for (const child of children) {
      if (child.type === 'text') {
        const cleaned = sanitizeXmlChars(child.value);
        if (cleaned.length > 0) {
          const prev = out[out.length - 1];
          if (prev && prev.type === 'text') prev.value += cleaned;
          else out.push(txt(cleaned));
        }
        continue;
      }

      const ns = child.ns ?? parentNs;
      const rawLocal = localName(child.tag);
      const lowerTag = rawLocal.toLowerCase();

      if (ns === 'xhtml' && DROP_WITH_CONTENT_XHTML.has(lowerTag)) {
        continue;
      }
      if (ns === 'svg' && DROP_WITH_CONTENT_SVG.has(lowerTag)) {
        continue;
      }
      if (ns === 'math' && lowerTag === 'script') {
        continue;
      }

      let outTag = rawLocal;
      let unwrap = false;
      if (ns === 'xhtml') {
        outTag = lowerTag;
        if (!ALLOWED_XHTML_TAGS.has(outTag)) {
          if (outTag === 'font' || outTag === 'big' || outTag === 'tt' || outTag === 'nobr') {
            outTag = 'span';
          } else if (outTag === 'center' || outTag === 'hgroup') {
            outTag = 'div';
          } else {
            unwrap = true;
          }
        }
      } else if (ns === 'svg') {
        if (!ALLOWED_SVG_TAGS.has(outTag)) {
          if (ALLOWED_SVG_TAGS.has(lowerTag)) outTag = lowerTag;
          else unwrap = true;
        }
      } else if (ns === 'math') {
        outTag = lowerTag;
        if (!ALLOWED_MATH_TAGS.has(outTag)) {
          unwrap = true;
        }
      }

      if (unwrap) {
        const unwrapped = sanitizeChildren(child.children, ns, insideSup);
        for (const u of unwrapped) {
          if (u.type === 'text' && out.length > 0 && out[out.length - 1]!.type === 'text') {
            (out[out.length - 1] as { value: string }).value += u.value;
          } else {
            out.push(u);
          }
        }
        continue;
      }

      const skipThis = shouldMarkSkip(child, insideSup);
      const nextAttrs: Record<string, string> = {};
      const allowedSet =
        ns === 'svg' ? ALLOWED_SVG_ATTRS : ns === 'math' ? ALLOWED_MATH_ATTRS : ALLOWED_HTML_ATTRS;

      for (const [rawAttrName, rawAttrVal] of Object.entries(child.attrs)) {
        const lowerAttr = rawAttrName.toLowerCase();
        // Drop all `on*` event handlers and dangerous navigation attributes (`§5.2`)
        if (
          lowerAttr.startsWith('on') ||
          lowerAttr === 'srcset' ||
          lowerAttr === 'target' ||
          lowerAttr === 'formaction' ||
          lowerAttr === 'srcdoc' ||
          lowerAttr === 'ping'
        ) {
          continue;
        }

        const isAria = lowerAttr.startsWith('aria-');
        if (!isAria && !allowedSet.has(rawAttrName) && !allowedSet.has(lowerAttr)) {
          continue;
        }

        const canonicalAttr =
          ns === 'svg' && allowedSet.has(rawAttrName) ? rawAttrName : lowerAttr;

        if (canonicalAttr === 'style') {
          const cleanStyle = sanitizeInlineStyle(
            rawAttrVal,
            options.sectionPath,
            resources,
            resourceResolver,
          );
          if (cleanStyle) nextAttrs['style'] = cleanStyle;
          continue;
        }

        // SVG `fill="url(#grad)"` / `clip-path="url(#clip)"` — allow local `#id` only, drop external URLs!
        if (ns === 'svg' && /url\s*\(/i.test(rawAttrVal)) {
          if (/^\s*url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)\s*$/i.test(rawAttrVal)) {
            nextAttrs[canonicalAttr] = rawAttrVal.trim();
          }
          continue;
        }

        if (canonicalAttr === 'src' || (ns === 'svg' && (canonicalAttr === 'href' || canonicalAttr === 'xlink:href'))) {
          if (ns === 'svg' && outTag === 'use' && rawAttrVal.trim().startsWith('#')) {
            nextAttrs[canonicalAttr] = rawAttrVal.trim();
            continue;
          }
          const res = resourceResolver(rawAttrVal, options.sectionPath);
          if (res) {
            if (res.resourcePath) resources.add(res.resourcePath);
            nextAttrs[canonicalAttr] = res.placeholder;
          }
          continue;
        }

        if (ns === 'xhtml' && outTag === 'a' && canonicalAttr === 'href') {
          const resolvedLink = linkResolver(rawAttrVal, options.sectionPath);
          if (resolvedLink?.external) {
            nextAttrs['href'] = '#';
            nextAttrs['data-mb-ext'] = resolvedLink.external;
          } else if (resolvedLink?.loc) {
            nextAttrs['href'] = '#';
            nextAttrs['data-mb-loc'] = resolvedLink.loc;
          }
          continue;
        }

        if (canonicalAttr === 'href' && ns !== 'svg') {
          continue;
        }

        nextAttrs[canonicalAttr] = sanitizeXmlChars(rawAttrVal);
      }

      // If an `<img>` or SVG `<image>` had its remote/unsafe `src` removed, replace with its `alt` text or drop
      if (ns === 'xhtml' && outTag === 'img' && !nextAttrs['src']) {
        const altText = nextAttrs['alt']?.trim();
        if (altText) {
          out.push(el('span', { class: 'mb-img-alt' }, [txt(altText)], 'xhtml'));
        }
        continue;
      }
      if (ns === 'svg' && outTag === 'image' && !nextAttrs['href'] && !nextAttrs['xlink:href']) {
        continue;
      }

      if (skipThis) {
        nextAttrs['data-mb-skip'] = '';
      }

      const nextChildren = sanitizeChildren(child.children, ns, insideSup || (ns === 'xhtml' && outTag === 'sup'));
      out.push(el(outTag, nextAttrs, nextChildren, ns));
    }
    return out;
  };

  const sourceChildren =
    bodyEl === docRoot && localName(docRoot.tag).toLowerCase() !== 'body' && localName(docRoot.tag).toLowerCase() !== 'html'
      ? [docRoot]
      : bodyEl.children;

  const bodyChildren = sanitizeChildren(sourceChildren, 'xhtml', false);

  // Detect cover-like section: zero counted text + at least 1 `<img>` or `<svg>` (`§6.3`)
  let hasNonWsText = false;
  let mediaCount = 0;
  const scanCover = (nodes: readonly MNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        if (n.value.trim().length > 0) hasNonWsText = true;
      } else {
        if ('data-mb-skip' in n.attrs) continue;
        if (n.tag === 'img' || n.ns === 'svg') mediaCount++;
        else scanCover(n.children);
      }
    }
  };
  scanCover(bodyChildren);

  return {
    bodyChildren,
    css: cssBlocks.join('\n'),
    lang,
    dir,
    resources: [...resources],
    isCoverLike: !hasNonWsText && mediaCount === 1,
  };
}
