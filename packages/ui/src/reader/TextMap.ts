export interface TextMapEntry {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

export function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isInsideSkipSubtree(node: Node, root: Element): boolean {
  let cur: Node | null = node.parentNode;
  while (cur && cur !== root && cur.nodeType === 1) {
    const el = cur as Element;
    if (el.hasAttribute('data-mb-skip')) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') return true;
    cur = cur.parentNode;
  }
  return false;
}

/**
 * Walks counted DOM text nodes skipping `[data-mb-skip]` subtrees (`ARCHITECTURE.md` §5.3, §6.5).
 * Verifies invariant `I-TEXT` (exact length + FNV-1a rolling hash against `SectionText.text`)
 * and provides O(log N) forward/reverse DOM `Range` <-> offset lookup.
 */
export class TextMap {
  readonly entries: readonly TextMapEntry[];
  readonly text: string;
  readonly invariantMatched: boolean;
  private readonly nodeStarts = new WeakMap<Text, number>();
  private readonly root: Element;

  constructor(root: Element, expectedText?: string) {
    this.root = root;
    const entries: TextMapEntry[] = [];
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);

    let offset = 0;
    const chunks: string[] = [];
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const val = textNode.nodeValue ?? '';
      if (val.length > 0 && !isInsideSkipSubtree(textNode, root)) {
        const start = offset;
        const end = start + val.length;
        entries.push({ node: textNode, start, end });
        this.nodeStarts.set(textNode, start);
        chunks.push(val);
        offset = end;
      }
      current = walker.nextNode();
    }

    const built = chunks.join('');
    this.entries = entries;
    this.text = built;

    if (expectedText !== undefined) {
      this.invariantMatched =
        built.length === expectedText.length && fnv1aHash(built) === fnv1aHash(expectedText);
    } else {
      this.invariantMatched = true;
    }
  }

  get length(): number {
    return this.text.length;
  }

  locateOffset(localOffset: number, preferEnd = false): { node: Text; nodeOffset: number } | null {
    if (this.entries.length === 0) return null;
    const clamped = Math.max(0, Math.min(this.length, localOffset));

    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const entry = this.entries[mid]!;
      if (clamped < entry.start) {
        hi = mid - 1;
      } else if (clamped > entry.end || (!preferEnd && clamped === entry.end && mid < this.entries.length - 1)) {
        lo = mid + 1;
      } else {
        return { node: entry.node, nodeOffset: clamped - entry.start };
      }
    }

    const fallback = this.entries[Math.min(this.entries.length - 1, Math.max(0, lo))]!;
    return {
      node: fallback.node,
      nodeOffset: Math.max(0, Math.min(fallback.end - fallback.start, clamped - fallback.start)),
    };
  }

  rangeFor(localStart: number, localEnd: number): Range | null {
    if (this.entries.length === 0) return null;
    const s = Math.max(0, Math.min(this.length, localStart));
    const e = Math.max(s, Math.min(this.length, localEnd));
    const startPos = this.locateOffset(s, false);
    const endPos = this.locateOffset(e, true);
    if (!startPos || !endPos) return null;

    const range = this.root.ownerDocument.createRange();
    range.setStart(startPos.node, startPos.nodeOffset);
    range.setEnd(endPos.node, endPos.nodeOffset);
    return range;
  }

  charRangeAt(localOffset: number): Range | null {
    if (this.length === 0) return null;
    const s = Math.max(0, Math.min(this.length - 1, localOffset));
    return this.rangeFor(s, Math.min(this.length, s + 1));
  }

  offsetFromPointOrRangeNode(container: Node, nodeOffset: number): number | null {
    if (this.entries.length === 0) return 0;

    if (container.nodeType === 3 /* TEXT_NODE */) {
      const t = container as Text;
      const direct = this.nodeStarts.get(t);
      if (direct !== undefined) {
        const len = t.nodeValue?.length ?? 0;
        return direct + Math.max(0, Math.min(len, nodeOffset));
      }
    }

    // Snap skipped or element containers forward to the nearest following counted text node (`§6.5`)
    let anchor: Node | null = container;
    if (container.nodeType === 1 /* ELEMENT_NODE */) {
      const children = container.childNodes;
      if (nodeOffset < children.length) {
        anchor = children[nodeOffset]!;
      } else if (children.length > 0) {
        anchor = children[children.length - 1]!;
      }
    }

    for (const entry of this.entries) {
      if (!anchor) return entry.start;
      const cmp = anchor.compareDocumentPosition(entry.node);
      if (
        entry.node === anchor ||
        (cmp & 4 /* DOCUMENT_POSITION_FOLLOWING */) !== 0 ||
        (cmp & 16 /* DOCUMENT_POSITION_CONTAINED_BY */) !== 0
      ) {
        return entry.start;
      }
    }

    return this.entries[this.entries.length - 1]!.end;
  }
}
