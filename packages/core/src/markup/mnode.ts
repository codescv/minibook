/**
 * Lightweight DOM-free markup AST shared by the XML tokenizer, `parse5` adapter,
 * FB2/TXT/Markdown builders, sanitizer, canonical text-model extractor, and XHTML serializer.
 *
 * All tree traversals (`textContent`, `findFirst`, `findAll`) are iterative so pathologically
 * deep book markup can never overflow the JS call stack.
 */

export type MNamespace = 'xhtml' | 'svg' | 'math';

export const MAX_MARKUP_DEPTH = 512;

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

export function textContent(root: MNode): string {
  if (root.type === 'text') return root.value;
  let out = '';
  const stack: MNode[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.type === 'text') {
      out += cur.value;
    } else {
      for (let i = cur.children.length - 1; i >= 0; i--) {
        stack.push(cur.children[i]!);
      }
    }
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
  const stack: MElement[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (predicate(cur)) return cur;
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const child = cur.children[i]!;
      if (child.type === 'element') stack.push(child);
    }
  }
  return null;
}

export function findAll(
  root: MElement,
  predicate: (node: MElement) => boolean,
  acc: MElement[] = [],
): MElement[] {
  const stack: MElement[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (predicate(cur)) acc.push(cur);
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const child = cur.children[i]!;
      if (child.type === 'element') stack.push(child);
    }
  }
  return acc;
}
