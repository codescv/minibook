import { localName, type MElement, type MNode } from '../markup/mnode.js';

const HEADING_KEYWORD_RE =
  /^(?:第\s*[0-9零一二三四五六七八九十百千萬〇兩]+\s*[回章節卷部篇集幕場]|卷\s*[0-9零一二三四五六七八九十百千]+|[序跋引楔凡例目錄附錄後記前言導讀楔子]|chapter\b|part\b|book\b|section\b|prologue\b|epilogue\b|preface\b|foreword\b|introduction\b|appendix\b|contents\b)/iu;

/**
 * Normalizes a candidate TOC heading:
 *   - Collapses internal whitespace.
 *   - Strips balanced surrounding ASCII/CJK quotes (`"\"Cover\""` -> `"Cover"`).
 *   - Rejects decorative rules / divider lines containing zero letters or digits (`————`, `***`, `===`).
 */
export function cleanTocHeading(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return null;

  // Strip balanced surrounding quotes repeatedly (`"\"Cover\""` -> `Cover`, `“序”` -> `序`)
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
    ['「', '」'],
    ['『', '』'],
  ];
  let stripped = true;
  while (stripped && s.length >= 2) {
    stripped = false;
    for (const [openQ, closeQ] of quotePairs) {
      if (s.startsWith(openQ) && s.endsWith(closeQ)) {
        const inner = s.slice(openQ.length, s.length - closeQ.length).trim();
        if (inner.length > 0 && !inner.includes(openQ) && !inner.includes(closeQ)) {
          s = inner;
          stripped = true;
          break;
        }
      }
    }
  }

  // Strip leading/trailing decorative rule runs (`———— 第一回 ————` -> `第一回`)
  s = s.replace(/^[\s—─━―–\-_=*~·•═─＊※◇◈]+/u, '').replace(/[\s—─━―–\-_=*~·•═─＊※◇◈]+$/u, '').trim();
  if (!s) return null;

  // Must contain at least one letter, CJK ideograph, or digit
  if (!/[\p{L}\p{N}]/u.test(s)) return null;

  return s;
}

export function pickUsefulDocTitle(rawHeadTitle: string, bookTitle: string): string | null {
  const cleaned = cleanTocHeading(rawHeadTitle);
  if (!cleaned) return null;
  const cleanBook = cleanTocHeading(bookTitle) ?? bookTitle.trim();
  if (cleaned.toLowerCase() === cleanBook.toLowerCase()) return null;
  if (/project gutenberg ebook/i.test(cleaned)) return null;
  return cleaned;
}

function textWithLineBreaks(node: MNode): string {
  const parts: string[] = [];
  const stack: MNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.type === 'text') {
      parts.push(cur.value);
      continue;
    }
    if ('data-mb-skip' in cur.attrs) continue;
    const tag = localName(cur.tag).toLowerCase();
    if (tag === 'br' || tag === 'hr') {
      parts.push('\n');
      continue;
    }
    for (let i = cur.children.length - 1; i >= 0; i--) {
      stack.push(cur.children[i]!);
    }
  }
  return parts.join('');
}

export interface ScannedBodyInfo {
  readonly anchors: Map<string, number>;
  readonly heading: string | null;
  readonly countedChars: number;
}

/**
 * Walks sanitized `bodyChildren` in a single pass to collect:
 *   1. Exact `id -> countedCharOffset` mappings (`I-TEXT` aligned).
 *   2. Best section heading (`<h1>`–`<h6>` -> `usefulHeadTitle` -> first non-rule short heading line).
 *   3. Exact `countedChars` (`SectionText.text.length`).
 */
export function scanSanitizedBody(
  bodyChildren: readonly MNode[],
  rawHeadTitle: string,
  bookTitle: string,
): ScannedBodyInfo {
  const anchors = new Map<string, number>();
  let explicitHeading: string | null = null;
  let fallbackLineHeading: string | null = null;
  let blockProbes = 0;
  let cursor = 0;

  const inspectBlockForLineHeading = (el: MElement) => {
    if (fallbackLineHeading || blockProbes >= 6) return;
    blockProbes++;
    const raw = textWithLineBreaks(el);
    for (const rawLine of raw.split(/\r?\n/)) {
      const cleaned = cleanTocHeading(rawLine);
      if (!cleaned) continue; // Skips `————`, `====`, blank lines!
      if (
        cleaned.length <= 80 &&
        (!/[。！？.!?]$/.test(cleaned) || HEADING_KEYWORD_RE.test(cleaned))
      ) {
        fallbackLineHeading = cleaned;
      }
      // Once we hit the first real text line of a substantive paragraph (`> 80` chars prose), stop probing lines in it
      if (cleaned.length > 80) return;
      if (fallbackLineHeading) return;
    }
  };

  const walk = (nodes: readonly MNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        cursor += n.value.length;
        continue;
      }
      const idVal = n.attrs['id'];
      if (idVal && !anchors.has(idVal)) {
        anchors.set(idVal, cursor);
      }
      if ('data-mb-skip' in n.attrs) continue;
      if (!explicitHeading && n.ns === 'xhtml' && /^h[1-6]$/.test(n.tag)) {
        const h = cleanTocHeading(textWithLineBreaks(n));
        if (h) explicitHeading = h;
      } else if (
        !explicitHeading &&
        !fallbackLineHeading &&
        blockProbes < 6 &&
        n.ns === 'xhtml' &&
        (n.tag === 'p' || n.tag === 'div' || n.tag === 'pre' || n.tag === 'blockquote')
      ) {
        // Only inspect leaf-ish blocks (avoid stringifying a root `<div>` wrapping the whole chapter)
        const hasChildBlocks = n.children.some(
          (c) => c.type === 'element' && (c.tag === 'p' || c.tag === 'div' || /^h[1-6]$/.test(c.tag)),
        );
        if (!hasChildBlocks) {
          inspectBlockForLineHeading(n);
        }
      }
      walk(n.children);
    }
  };
  walk(bodyChildren);

  const usefulHead = pickUsefulDocTitle(rawHeadTitle, bookTitle);
  return {
    anchors,
    heading: explicitHeading ?? usefulHead ?? fallbackLineHeading ?? null,
    countedChars: cursor,
  };
}

/**
 * O(N) linear character-code scanner for oversized (> 512 KiB) HTML/XHTML streams (e.g. a 20 MiB
 * single-section MOBI 6 book) so import-time `charLength` estimation completes in ~15 ms instead of
 * allocating a multi-million-node DOM AST. Skips `<head>`, `<style>`, `<script>`, `<rt>`, `<rp>`,
 * comments, and tags, and counts HTML entities (`&...;`) as 1 character.
 */
export function fastCountMarkupChars(markup: string): number {
  let count = 0;
  let i = 0;
  const n = markup.length;

  while (i < n) {
    const ch = markup.charCodeAt(i);
    if (ch === 0x3c) {
      // `<!-- ... -->`
      if (markup.startsWith('<!--', i)) {
        const endC = markup.indexOf('-->', i + 4);
        i = endC >= 0 ? endC + 3 : n;
        continue;
      }
      const gt = markup.indexOf('>', i + 1);
      if (gt < 0) break;
      const tagRaw = markup.slice(i + 1, gt).trim();
      if (tagRaw.length > 0 && tagRaw[0] !== '/' && tagRaw[0] !== '!' && tagRaw[0] !== '?' && !tagRaw.endsWith('/')) {
        const m = /^([a-zA-Z0-9:_-]+)/.exec(tagRaw);
        const tagName = m?.[1]?.toLowerCase() ?? '';
        if (
          tagName === 'head' ||
          tagName === 'style' ||
          tagName === 'script' ||
          tagName === 'rt' ||
          tagName === 'rp'
        ) {
          const closeRe = new RegExp(`<\\s*\\/\\s*${tagName}\\s*>`, 'ig');
          closeRe.lastIndex = gt + 1;
          const cm = closeRe.exec(markup);
          i = cm ? cm.index + cm[0].length : gt + 1;
          continue;
        }
      }
      i = gt + 1;
      continue;
    }

    if (ch === 0x26) {
      // `&entity;` -> count as 1 character if `;` within 12 chars
      const semi = markup.indexOf(';', i + 1);
      if (semi > i && semi - i <= 12) {
        count++;
        i = semi + 1;
        continue;
      }
    }

    // Surrogate pair counts as 2 UTF-16 code units matching JS `string.length`!
    count++;
    i++;
  }

  return count;
}

