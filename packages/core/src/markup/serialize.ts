import { escapeXmlAttr, escapeXmlText } from './entities.js';
import type { MElement, MNamespace, MNode } from './mnode.js';

const XHTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function isValidXmlName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/.test(name);
}

/**
 * Serializes sanitized `MNode[]` into deterministic, strictly well-formed XHTML (`§5.2`, `§6.1`).
 *
 * - Escapes only `&amp;`, `&lt;`, `&gt;`, `&quot;` with `\n` line endings.
 * - Declares `xmlns` on `<svg>`/`<math>` roots and `xmlns:epub` / `xmlns:xlink` whenever
 *   prefixed attributes survive, so `new DOMParser().parseFromString(..., 'application/xhtml+xml')`
 *   in the UI never encounters an undeclared XML namespace prefix!
 */
export function serializeXhtmlNodes(nodes: readonly MNode[]): string {
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    serializeInto(nodes[i]!, 'xhtml', false, false, parts);
  }
  return parts.join('');
}

export function serializeXhtmlElement(node: MElement): string {
  const parts: string[] = [];
  serializeInto(node, 'xhtml', false, false, parts);
  return parts.join('');
}

function serializeInto(
  node: MNode,
  parentNs: MNamespace,
  epubNsDeclared: boolean,
  xlinkNsDeclared: boolean,
  out: string[],
): void {
  if (node.type === 'text') {
    if (node.value.length > 0) {
      out.push(escapeXmlText(node.value));
    }
    return;
  }

  let tag = node.tag;
  const colonIdx = tag.indexOf(':');
  if (colonIdx >= 0) {
    tag = tag.slice(colonIdx + 1);
  }
  if (!isValidXmlName(tag)) {
    return;
  }

  let hasEpubPrefix = false;
  let hasXlinkPrefix = false;
  const cleanAttrs: Array<[string, string]> = [];

  for (const [rawKey, rawVal] of Object.entries(node.attrs)) {
    if (!isValidXmlName(rawKey)) continue;
    if (rawKey === 'xmlns' || rawKey.startsWith('xmlns:')) continue;

    if (rawKey.startsWith('epub:')) {
      hasEpubPrefix = true;
      cleanAttrs.push([rawKey, rawVal]);
    } else if (rawKey.startsWith('xlink:')) {
      hasXlinkPrefix = true;
      cleanAttrs.push([rawKey, rawVal]);
    } else if (rawKey.startsWith('xml:')) {
      // `xml:` prefix is pre-bound in all XML 1.0 processors (`xml:lang`, `xml:space`)
      cleanAttrs.push([rawKey, rawVal]);
    } else if (rawKey.includes(':')) {
      // Drop undeclared custom namespace prefixes that would break XML DOMParser
      continue;
    } else {
      cleanAttrs.push([rawKey, rawVal]);
    }
  }

  let nextEpubDeclared = epubNsDeclared;
  let nextXlinkDeclared = xlinkNsDeclared;

  out.push('<', tag);

  if (node.ns !== parentNs) {
    if (node.ns === 'svg') {
      out.push(' xmlns="http://www.w3.org/2000/svg"');
    } else if (node.ns === 'math') {
      out.push(' xmlns="http://www.w3.org/1998/Math/MathML"');
    } else {
      out.push(' xmlns="http://www.w3.org/1999/xhtml"');
    }
  }

  if (hasEpubPrefix && !epubNsDeclared) {
    out.push(' xmlns:epub="http://www.idpf.org/2007/ops"');
    nextEpubDeclared = true;
  }
  if ((hasXlinkPrefix || node.ns === 'svg') && !xlinkNsDeclared && hasXlinkPrefix) {
    out.push(' xmlns:xlink="http://www.w3.org/1999/xlink"');
    nextXlinkDeclared = true;
  }

  for (const [k, v] of cleanAttrs) {
    out.push(' ', k, '="', escapeXmlAttr(v), '"');
  }

  if (node.children.length === 0 && (node.ns !== 'xhtml' || XHTML_VOID_TAGS.has(tag))) {
    out.push('/>');
    return;
  }

  out.push('>');
  for (let i = 0; i < node.children.length; i++) {
    serializeInto(node.children[i]!, node.ns, nextEpubDeclared, nextXlinkDeclared, out);
  }
  out.push('</', tag, '>');
}
