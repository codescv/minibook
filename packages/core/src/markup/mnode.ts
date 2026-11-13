/**
 * Lightweight DOM-free markup AST shared by the XML tokenizer, `parse5` adapter,
 * FB2/TXT/Markdown builders, sanitizer, canonical text-model extractor, and XHTML serializer.
 */

export type MNamespace = 'xhtml' | 'svg' | 'math';

export interface MElement {
  readonly type: 'element';
  tag: string;
  ns: MNamespace;
  attrs: Record<string, string>;
  children: MNode[];
}

export interface MText {
  readonly type: 'text';
  value: string;
}

export type MNode = MElement | MText;

export function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: MNode[] = [],
  ns: MNamespace = 'xhtml',
): MElement {
  return { type: 'element', tag, ns, attrs, children };
}

export function txt(value: string): MText {
  return { type: 'text', value };
}

export function localName(qname: string): string {
  const idx = qname.indexOf(':');
  return idx >= 0 ? qname.slice(idx + 1) : qname;
}

export function getAttr(node: MElement, name: string): string | undefined {
  if (name in node.attrs) return node.attrs[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k.toLowerCase() === lower || localName(k).toLowerCase() === lower) {
      return v;
    }
  }
  return undefined;
}

export function textContent(node: MNode): string {
  if (node.type === 'text') return node.value;
  let out = '';
  for (let i = 0; i < node.children.length; i++) {
    out += textContent(node.children[i]!);
  }
  return out;
}

export function childElements(node: MElement, matchLocalTag?: string): MElement[] {
  const target = matchLocalTag?.toLowerCase();
  const res: MElement[] = [];
  for (const c of node.children) {
    if (c.type !== 'element') continue;
    if (!target || localName(c.tag).toLowerCase() === target) {
      res.push(c);
    }
  }
  return res;
}

export function findFirst(
  root: MElement,
  predicate: (node: MElement) => boolean,
): MElement | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    if (child.type === 'element') {
      const hit = findFirst(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

export function findAll(
  root: MElement,
  predicate: (node: MElement) => boolean,
  acc: MElement[] = [],
): MElement[] {
  if (predicate(root)) acc.push(root);
  for (const child of root.children) {
    if (child.type === 'element') {
      findAll(child, predicate, acc);
    }
  }
  return acc;
}
