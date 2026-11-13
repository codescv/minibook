import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { MiniBookError } from '../errors.js';
import { el, MAX_MARKUP_DEPTH, type MElement, type MNamespace, type MNode, txt } from './mnode.js';
import { parseXml } from './xml-tokenizer.js';

function mapNamespace(nsUri: string | undefined): MNamespace {
  if (nsUri === 'http://www.w3.org/2000/svg') return 'svg';
  if (nsUri === 'http://www.w3.org/1998/Math/MathML') return 'math';
  return 'xhtml';
}

// Preserve case-sensitive SVG camelCase tag names when parsed via HTML5 `parse5`
const SVG_CAMEL_TAGS: Readonly<Record<string, string>> = {
  altglyph: 'altGlyph',
  altglyphdef: 'altGlyphDef',
  altglyphitem: 'altGlyphItem',
  animatecolor: 'animateColor',
  animatemotion: 'animateMotion',
  animatetransform: 'animateTransform',
  clippath: 'clipPath',
  feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix',
  fecomponenttransfer: 'feComponentTransfer',
  fecomposite: 'feComposite',
  feconvolvematrix: 'feConvolveMatrix',
  fediffuselighting: 'feDiffuseLighting',
  fedisplacementmap: 'feDisplacementMap',
  fedistantlight: 'feDistantLight',
  fedropshadow: 'feDropShadow',
  feflood: 'feFlood',
  fefunca: 'feFuncA',
  fefuncb: 'feFuncB',
  fefuncg: 'feFuncG',
  fefuncr: 'feFuncR',
  fegaussianblur: 'feGaussianBlur',
  feimage: 'feImage',
  femerge: 'feMerge',
  femergenode: 'feMergeNode',
  femorphology: 'feMorphology',
  feoffset: 'feOffset',
  fepointlight: 'fePointLight',
  fespecularlighting: 'feSpecularLighting',
  fespotlight: 'feSpotLight',
  fetile: 'feTile',
  feturbulence: 'feTurbulence',
  foreignobject: 'foreignObject',
  glyphref: 'glyphRef',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  textpath: 'textPath',
};

const SVG_CAMEL_ATTRS: Readonly<Record<string, string>> = {
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  patternunits: 'patternUnits',
  patterntransform: 'patternTransform',
  clippathunits: 'clipPathUnits',
  spreadmethod: 'spreadMethod',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
  markerunits: 'markerUnits',
  refx: 'refX',
  refy: 'refY',
};

function convertParse5Node(node: DefaultTreeAdapterTypes.ChildNode, depth = 0): MNode | null {
  if (depth > MAX_MARKUP_DEPTH) {
    throw new MiniBookError('corrupt-book', `HTML element nesting exceeds maximum depth (${MAX_MARKUP_DEPTH})`);
  }
  if (node.nodeName === '#text') {
    const t = node as DefaultTreeAdapterTypes.TextNode;
    return txt(t.value);
  }
  if (node.nodeName.startsWith('#')) {
    return null;
  }
  const elem = node as DefaultTreeAdapterTypes.Element;
  const ns = mapNamespace(elem.namespaceURI);
  const rawTag = elem.tagName;
  const tag = ns === 'svg' ? (SVG_CAMEL_TAGS[rawTag] ?? rawTag) : rawTag.toLowerCase();
  const attrs: Record<string, string> = {};
  for (const attr of elem.attrs) {
    const rawAttrName = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    const attrName = ns === 'svg' ? (SVG_CAMEL_ATTRS[rawAttrName] ?? rawAttrName) : rawAttrName;
    attrs[attrName] = attr.value;
  }

  const children: MNode[] = [];
  if (elem.tagName === 'template') {
    const tmpl = elem as DefaultTreeAdapterTypes.Template;
    for (const c of tmpl.content.childNodes) {
      const converted = convertParse5Node(c, depth + 1);
      if (converted) children.push(converted);
    }
  } else if ('childNodes' in elem && Array.isArray(elem.childNodes)) {
    for (const c of elem.childNodes) {
      const converted = convertParse5Node(c, depth + 1);
      if (converted) children.push(converted);
    }
  }

  return el(tag, attrs, children, ns);
}

/**
 * Parses an HTML5 document via `parse5` into an `<html>` `MElement` tree.
 */
export function parseHtmlDocument(htmlSource: string): MElement {
  const doc = parse(htmlSource);
  for (const child of doc.childNodes) {
    const converted = convertParse5Node(child);
    if (converted && converted.type === 'element' && converted.tag === 'html') {
      return converted;
    }
  }
  const children: MNode[] = [];
  for (const child of doc.childNodes) {
    const converted = convertParse5Node(child);
    if (converted) children.push(converted);
  }
  return el('html', {}, [el('body', {}, children)]);
}

/**
 * Parses an HTML5 fragment via `parse5` into `MNode[]`.
 */
export function parseHtmlFragment(htmlSource: string): MNode[] {
  const frag = parseFragment(htmlSource);
  const out: MNode[] = [];
  for (const child of frag.childNodes) {
    const converted = convertParse5Node(child);
    if (converted) out.push(converted);
  }
  return out;
}

/**
 * Parses EPUB XHTML strictly with our XML tokenizer first; on any well-formedness error
 * (or when `preferHtml` is `true`, e.g. MOBI 6 tag soup), falls back cleanly to `parse5` (`§5.2`).
 */
export function parseXhtmlOrHtml(source: string, preferHtml = false): MElement {
  if (!preferHtml) {
    try {
      return parseXml(source, { strict: true, lowercaseXhtmlTags: true });
    } catch (err) {
      // Re-throw structural depth/size errors (`MAX_MARKUP_DEPTH`); fall back to `parse5` for tag-soup syntax
      if (err instanceof MiniBookError && /maximum depth/i.test(err.message)) {
        throw err;
      }
    }
  }
  return parseHtmlDocument(source);
}
