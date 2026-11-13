import { el, getAttr, type MElement, type MNode } from '../markup/mnode.js';
import { serializeXhtmlNodes } from '../markup/serialize.js';
import type {
  ReadingDirection,
  RenderUnitRange,
  SectionDoc,
  SectionText,
  TextBlock,
  TextBlockKind,
} from '../types.js';

export const MAX_RENDER_UNIT_CHARS = 40_000; // `ARCHITECTURE.md` §4.8

const BLOCK_TAG_KIND: Readonly<Record<string, TextBlockKind>> = {
  p: 'p',
  div: 'p',
  h1: 'h',
  h2: 'h',
  h3: 'h',
  h4: 'h',
  h5: 'h',
  h6: 'h',
  li: 'li',
  td: 'cell',
  th: 'cell',
  blockquote: 'quote',
  pre: 'pre',
  dt: 'other',
  dd: 'other',
  figcaption: 'other',
  section: 'other',
  article: 'other',
  aside: 'other',
  header: 'other',
  footer: 'other',
  main: 'other',
};

function isBlockElement(node: MElement): boolean {
  return node.ns === 'xhtml' && node.tag in BLOCK_TAG_KIND;
}

function hasChildBlockElement(node: MElement): boolean {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if ('data-mb-skip' in child.attrs) continue;
    if (isBlockElement(child) || hasChildBlockElement(child)) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the canonical `SectionText` from sanitized `MNode[]` (`ARCHITECTURE.md` §5.3):
 *   - Concatenates all text nodes outside `[data-mb-skip]` subtrees in exact document order.
 *   - Produces ordered, non-overlapping `TextBlock` ranges for paragraph/heading/list/cell/quote/pre units.
 *   - Guaranteed by construction to satisfy `I-TEXT` (`walkXhtmlSkippingMbSkip(xhtml) === text.text`).
 */
export function buildSectionText(
  nodes: readonly MNode[],
  defaultLang: string | null = null,
): SectionText {
  let text = '';
  const blocks: TextBlock[] = [];

  const emitBlockIfNonEmpty = (start: number, end: number, kind: TextBlockKind, lang: string | null) => {
    if (end <= start) return;
    if (text.slice(start, end).trim().length === 0) return;
    blocks.push({ start, end, kind, lang });
  };

  const appendCountedSubtree = (node: MNode): void => {
    if (node.type === 'text') {
      text += node.value;
      return;
    }
    if ('data-mb-skip' in node.attrs) {
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      appendCountedSubtree(node.children[i]!);
    }
  };

  const walkContainer = (
    children: readonly MNode[],
    inheritedLang: string | null,
    inheritedKind: TextBlockKind,
  ): void => {
    let inlineRunStart: number | null = null;

    const flushInlineRun = () => {
      if (inlineRunStart !== null) {
        emitBlockIfNonEmpty(inlineRunStart, text.length, inheritedKind, inheritedLang);
        inlineRunStart = null;
      }
    };

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (child.type === 'text') {
        if (inlineRunStart === null) inlineRunStart = text.length;
        text += child.value;
        continue;
      }

      if ('data-mb-skip' in child.attrs) {
        continue;
      }

      const nodeLang = getAttr(child, 'lang') ?? getAttr(child, 'xml:lang') ?? inheritedLang;

      if (isBlockElement(child)) {
        flushInlineRun();
        const ownKind = BLOCK_TAG_KIND[child.tag] ?? 'other';
        const effectiveKind: TextBlockKind =
          ownKind === 'p' && inheritedKind === 'quote'
            ? 'quote'
            : ownKind === 'other' && inheritedKind !== 'other'
              ? inheritedKind
              : ownKind;

        if (hasChildBlockElement(child)) {
          walkContainer(child.children, nodeLang, effectiveKind);
        } else {
          const blockStart = text.length;
          appendCountedSubtree(child);
          emitBlockIfNonEmpty(blockStart, text.length, effectiveKind, nodeLang);
        }
      } else if (hasChildBlockElement(child)) {
        flushInlineRun();
        walkContainer(child.children, nodeLang, inheritedKind);
      } else {
        if (inlineRunStart === null) inlineRunStart = text.length;
        appendCountedSubtree(child);
      }
    }

    flushInlineRun();
  };

  walkContainer(nodes, defaultLang, 'p');

  return { text, blocks };
}

function countedLength(node: MNode): number {
  if (node.type === 'text') return node.value.length;
  if ('data-mb-skip' in node.attrs) return 0;
  let sum = 0;
  for (let i = 0; i < node.children.length; i++) {
    sum += countedLength(node.children[i]!);
  }
  return sum;
}

/**
 * Splits oversized node trees (`> 40,000` counted chars) into top-level / child-block
 * chunks without mutating or losing counted text (`ARCHITECTURE.md` §4.8).
 */
function flattenOversizedNodes(nodes: readonly MNode[], maxChars: number): MNode[][] {
  const groups: MNode[][] = [];
  let currentGroup: MNode[] = [];
  let currentLen = 0;

  const flush = () => {
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
      currentLen = 0;
    }
  };

  const pushNode = (node: MNode) => {
    const len = countedLength(node);
    if (len <= maxChars) {
      if (currentLen > 0 && currentLen + len > maxChars) {
        flush();
      }
      currentGroup.push(node);
      currentLen += len;
      return;
    }

    // Node alone exceeds `maxChars`: if it is a container element with children, split its children recursively
    if (node.type === 'element' && node.children.length > 1) {
      flush();
      const subGroups = flattenOversizedNodes(node.children, maxChars);
      for (let idx = 0; idx < subGroups.length; idx++) {
        const sg = subGroups[idx]!;
        const clonedAttrs = { ...node.attrs };
        // Preserve `id` only on the first split wrapper so duplicate XML `id`s are never emitted
        if (idx > 0 && 'id' in clonedAttrs) {
          delete clonedAttrs['id'];
        }
        groups.push([el(node.tag, clonedAttrs, sg, node.ns)]);
      }
      return;
    }

    // Single gigantic text/leaf element with no child split points: split text at whitespace/punctuation near `maxChars`
    if (node.type === 'element' && node.children.length === 1 && node.children[0]!.type === 'text') {
      flush();
      const fullStr = node.children[0]!.value;
      let cursor = 0;
      let partIdx = 0;
      while (cursor < fullStr.length) {
        let cut = Math.min(fullStr.length, cursor + maxChars);
        if (cut < fullStr.length) {
          const searchBack = Math.max(cursor + Math.floor(maxChars * 0.7), cut - 512);
          for (let k = cut; k >= searchBack; k--) {
            const ch = fullStr[k - 1]!;
            if (ch === '\n' || ch === ' ' || ch === '。' || ch === '！' || ch === '？' || ch === '.') {
              cut = k;
              break;
            }
          }
        }
        const clonedAttrs = { ...node.attrs };
        if (partIdx > 0 && 'id' in clonedAttrs) delete clonedAttrs['id'];
        groups.push([el(node.tag, clonedAttrs, [{ type: 'text', value: fullStr.slice(cursor, cut) }], node.ns)]);
        cursor = cut;
        partIdx++;
      }
      return;
    }

    flush();
    groups.push([node]);
  };

  for (const node of nodes) {
    pushNode(node);
  }
  flush();

  return groups.length > 0 ? groups : [[]];
}

function collectReferencedResources(xhtml: string, css: string, allResources: readonly string[]): string[] {
  if (allResources.length === 0) return [];
  const used: string[] = [];
  for (const res of allResources) {
    const token = `mb-res:${res}`;
    if (xhtml.includes(token) || css.includes(token)) {
      used.push(res);
    }
  }
  return used;
}

export interface BuiltSectionUnits {
  readonly fullText: SectionText;
  readonly units: readonly SectionDoc[];
}

/**
 * Produces both the full section's `SectionText` AND `1..N` bounded `SectionDoc` render units
 * (`<= 40,000` counted chars each per `ARCHITECTURE.md` §4.8).
 */
export function buildSectionRenderUnits(params: {
  readonly sectionIndex: number;
  readonly bodyChildren: readonly MNode[];
  readonly css: string;
  readonly lang: string | null;
  readonly dir: ReadingDirection;
  readonly resources: readonly string[];
  readonly isCoverLike: boolean;
  readonly maxUnitChars?: number;
}): BuiltSectionUnits {
  const maxUnitChars = params.maxUnitChars ?? MAX_RENDER_UNIT_CHARS;
  const fullText = buildSectionText(params.bodyChildren, params.lang);

  if (fullText.text.length <= maxUnitChars) {
    const xhtml = serializeXhtmlNodes(params.bodyChildren);
    const unitRange: RenderUnitRange = { start: 0, end: fullText.text.length };
    const doc: SectionDoc = {
      index: params.sectionIndex,
      unit: unitRange,
      unitIndex: 0,
      units: [unitRange],
      xhtml,
      css: params.css,
      lang: params.lang,
      dir: params.dir,
      text: fullText,
      resources: collectReferencedResources(xhtml, params.css, params.resources),
      isCoverLike: params.isCoverLike,
    };
    return { fullText, units: [doc] };
  }

  const nodeGroups = flattenOversizedNodes(params.bodyChildren, maxUnitChars);
  const unitData: Array<{
    range: RenderUnitRange;
    xhtml: string;
    text: SectionText;
    resources: string[];
  }> = [];

  let runningOffset = 0;
  for (const group of nodeGroups) {
    const unitText = buildSectionText(group, params.lang);
    const xhtml = serializeXhtmlNodes(group);
    const start = runningOffset;
    const end = runningOffset + unitText.text.length;
    runningOffset = end;
    unitData.push({
      range: { start, end },
      xhtml,
      text: unitText,
      resources: collectReferencedResources(xhtml, params.css, params.resources),
    });
  }

  const allRanges: readonly RenderUnitRange[] = unitData.map((u) => u.range);
  const units: SectionDoc[] = unitData.map((u, idx) => ({
    index: params.sectionIndex,
    unit: u.range,
    unitIndex: idx,
    units: allRanges,
    xhtml: u.xhtml,
    css: params.css,
    lang: params.lang,
    dir: params.dir,
    text: u.text,
    resources: u.resources,
    isCoverLike: false,
  }));

  return { fullText, units };
}
