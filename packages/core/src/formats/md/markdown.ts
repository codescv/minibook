import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { decodeBytesWithEncoding, detectTextEncoding } from '../../io/encoding.js';
import { sanitizeXmlChars } from '../../markup/entities.js';
import { el, type MElement, type MNode, textContent, txt } from '../../markup/mnode.js';
import type {
  BookInspectHint,
  BookMeta,
  BookOpenHint,
  BookResource,
  BookSession,
  ByteSource,
  CoverImage,
  InspectedBook,
  ResolvedHref,
  SectionDoc,
  SectionRef,
  SectionText,
  TocItem,
  TxtBookIndex,
  TxtChapterIndexEntry,
} from '../../types.js';
import { LruCache } from '../../util/lru.js';
import { isRemoteOrExternalScheme, isSafeDataImageUri } from '../../util/path.js';
import { MAX_TXT_SECTION_CHARS } from '../txt/chapters.js';

function parseInlineMarkdown(rawText: string): MNode[] {
  const src = sanitizeXmlChars(rawText);
  const out: MNode[] = [];
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain.length > 0) {
      out.push(txt(plain));
      plain = '';
    }
  };

  while (i < src.length) {
    const ch = src[i]!;

    // Backslash escape `\*`, `\_`, `\[`, ...
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|<>]/.test(src[i + 1]!)) {
      plain += src[i + 1]!;
      i += 2;
      continue;
    }

    // Inline code `` `code` ``
    if (ch === '`') {
      let tickLen = 1;
      while (i + tickLen < src.length && src[i + tickLen] === '`') tickLen++;
      const fence = '`'.repeat(tickLen);
      const endIdx = src.indexOf(fence, i + tickLen);
      if (endIdx >= 0) {
        flushPlain();
        const codeContent = src.slice(i + tickLen, endIdx);
        out.push(el('code', {}, [txt(codeContent)]));
        i = endIdx + tickLen;
        continue;
      }
      plain += fence;
      i += tickLen;
      continue;
    }

    // Image `![alt](url)`
    if (ch === '!' && src[i + 1] === '[') {
      const parsed = matchBracketLink(src, i + 1);
      if (parsed) {
        flushPlain();
        const url = parsed.url.trim();
        if (isSafeDataImageUri(url)) {
          out.push(
            el('img', {
              src: url,
              ...(parsed.label ? { alt: parsed.label } : {}),
              ...(parsed.title ? { title: parsed.title } : {}),
            }),
          );
        } else if (parsed.label) {
          out.push(el('span', { class: 'mb-img-alt' }, [txt(parsed.label)]));
        }
        i = parsed.nextIndex;
        continue;
      }
    }

    // Link `[label](url)`
    if (ch === '[') {
      const parsed = matchBracketLink(src, i);
      if (parsed) {
        flushPlain();
        const ext = isRemoteOrExternalScheme(parsed.url);
        const linkChildren = parseInlineMarkdown(parsed.label);
        if (ext) {
          out.push(el('a', { href: '#', 'data-mb-ext': ext }, linkChildren));
        } else if (parsed.url.trim().startsWith('#')) {
          out.push(el('a', { href: '#', 'data-mb-loc': `0${parsed.url.trim()}` }, linkChildren));
        } else {
          out.push(...linkChildren);
        }
        i = parsed.nextIndex;
        continue;
      }
    }

    // Bold `**...**` or `__...__`
    if ((ch === '*' && src[i + 1] === '*') || (ch === '_' && src[i + 1] === '_')) {
      const delim = ch + ch;
      const endIdx = src.indexOf(delim, i + 2);
      if (endIdx > i + 2) {
        flushPlain();
        out.push(el('strong', {}, parseInlineMarkdown(src.slice(i + 2, endIdx))));
        i = endIdx + 2;
        continue;
      }
    }

    // Strikethrough `~~...~~`
    if (ch === '~' && src[i + 1] === '~') {
      const endIdx = src.indexOf('~~', i + 2);
      if (endIdx > i + 2) {
        flushPlain();
        out.push(el('s', {}, parseInlineMarkdown(src.slice(i + 2, endIdx))));
        i = endIdx + 2;
        continue;
      }
    }

    // Emphasis `*...*` or `_..._`
    if (ch === '*' || ch === '_') {
      if (ch === '_' && i > 0 && /[A-Za-z0-9]/.test(src[i - 1]!)) {
        plain += ch;
        i++;
        continue;
      }
      const endIdx = src.indexOf(ch, i + 1);
      if (endIdx > i + 1 && src[i + 1] !== ' ') {
        flushPlain();
        out.push(el('em', {}, parseInlineMarkdown(src.slice(i + 1, endIdx))));
        i = endIdx + 1;
        continue;
      }
    }

    plain += ch;
    i++;
  }

  flushPlain();
  return out;
}

function matchBracketLink(
  src: string,
  openBracketIdx: number,
): { readonly label: string; readonly url: string; readonly title?: string; readonly nextIndex: number } | null {
  let depth = 0;
  let closeBracket = -1;
  for (let i = openBracketIdx; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) {
        closeBracket = i;
        break;
      }
    }
  }
  if (closeBracket < 0 || src[closeBracket + 1] !== '(') return null;

  let parenDepth = 0;
  let closeParen = -1;
  for (let i = closeBracket + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        closeParen = i;
        break;
      }
    }
  }
  if (closeParen < 0) return null;

  const label = src.slice(openBracketIdx + 1, closeBracket);
  const rawInside = src.slice(closeBracket + 2, closeParen).trim();
  const titleMatch = /^(\S+)\s+["']([^"']*)["']$/.exec(rawInside);
  if (titleMatch) {
    return {
      label,
      url: titleMatch[1]!,
      title: titleMatch[2]!,
      nextIndex: closeParen + 1,
    };
  }
  return {
    label,
    url: rawInside,
    nextIndex: closeParen + 1,
  };
}

function isGfmTableDelimiterRow(line: string): Array<'left' | 'center' | 'right' | null> | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return null;
  const rawCells = splitPipeRow(trimmed);
  if (rawCells.length === 0) return null;
  const aligns: Array<'left' | 'center' | 'right' | null> = [];
  for (const c of rawCells) {
    const t = c.trim();
    if (!/^:?-{3,}:?$/.test(t)) return null;
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += s[i]!;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Pure-TS CommonMark + GFM subset block parser (`ARCHITECTURE.md` §4.7).
 * Raw HTML in Markdown is ALWAYS escaped as literal text (never executed or parsed as DOM).
 */
export function renderMarkdownToNodes(markdown: string): MElement[] {
  const lines = sanitizeXmlChars(markdown).split('\n');
  return parseMarkdownBlocks(lines);
}

function parseMarkdownBlocks(lines: readonly string[]): MElement[] {
  const blocks: MElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      i++;
      continue;
    }

    // Fenced code block ```` ```lang ```` or `~~~`
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})([^\n`]*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      const fenceChar = fence[0]!;
      const langInfo = fenceMatch[2]!.trim().split(/\s+/)[0] ?? '';
      i++;
      const codeLines: string[] = [];
      while (i < lines.length) {
        const closeMatch = new RegExp(`^ {0,3}${fenceChar}{${fence.length},}\\s*$`).test(lines[i]!);
        if (closeMatch) {
          i++;
          break;
        }
        codeLines.push(lines[i]!);
        i++;
      }
      const codeAttrs: Record<string, string> = langInfo ? { class: `language-${langInfo}` } : {};
      blocks.push(
        el('pre', {}, [el('code', codeAttrs, [txt(`${codeLines.join('\n')}\n`)])]),
      );
      continue;
    }

    // ATX Heading `#`..`######`
    const atxMatch = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(line);
    if (atxMatch) {
      const level = atxMatch[1]!.length;
      const headingRaw = atxMatch[2] ?? '';
      const inline = parseInlineMarkdown(`${headingRaw}\n`);
      blocks.push(el(`h${level}`, {}, inline));
      i++;
      continue;
    }

    // Thematic break `---`, `***`, `___`
    if (/^ {0,3}(?:-\s*){3,}$|^ {0,3}(?:\*\s*){3,}$|^ {0,3}(?:_\s*){3,}$/.test(line)) {
      blocks.push(el('hr', {}));
      i++;
      continue;
    }

    // Blockquote `> ...`
    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && (/^ {0,3}>/.test(lines[i]!) || (lines[i]!.trim().length > 0 && quoteLines.length > 0 && !/^ {0,3}(?:#{1,6}\s|```|~~~)/.test(lines[i]!)))) {
        if (/^ {0,3}>/.test(lines[i]!)) {
          quoteLines.push(lines[i]!.replace(/^ {0,3}> ?/, ''));
        } else {
          quoteLines.push(lines[i]!);
        }
        i++;
      }
      blocks.push(el('blockquote', {}, parseMarkdownBlocks(quoteLines)));
      continue;
    }

    // GFM Table
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = isGfmTableDelimiterRow(lines[i + 1]!);
      if (aligns) {
        const headerCells = splitPipeRow(line);
        i += 2;
        const thNodes = headerCells.map((cell, cIdx) => {
          const align = aligns[cIdx];
          const attrs: Record<string, string> = align ? { style: `text-align: ${align}` } : {};
          return el('th', attrs, parseInlineMarkdown(`${cell} `));
        });
        const thead = el('thead', {}, [el('tr', {}, thNodes)]);
        const bodyRows: MElement[] = [];
        while (i < lines.length && lines[i]!.trim().length > 0 && lines[i]!.includes('|')) {
          const rowCells = splitPipeRow(lines[i]!);
          const tdNodes = aligns.map((align, cIdx) => {
            const cellText = rowCells[cIdx] ?? '';
            const attrs: Record<string, string> = align ? { style: `text-align: ${align}` } : {};
            return el('td', attrs, parseInlineMarkdown(cIdx === aligns.length - 1 ? `${cellText}\n` : `${cellText} `));
          });
          bodyRows.push(el('tr', {}, tdNodes));
          i++;
        }
        blocks.push(el('table', {}, [thead, el('tbody', {}, bodyRows)]));
        continue;
      }
    }

    // Unordered or Ordered List (with nested sublist support!)
    const listMatch = /^( *)([*+-]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const baseIndent = listMatch[1]!.length;
      const isOrdered = /\d/.test(listMatch[2]![0]!);
      const listTag = isOrdered ? 'ol' : 'ul';
      const items: MElement[] = [];

      while (i < lines.length) {
        const curLine = lines[i]!;
        if (curLine.trim().length === 0) {
          if (i + 1 < lines.length) {
            const nextM = /^( *)([*+-]|\d+[.)])\s+/.exec(lines[i + 1]!);
            if (nextM && nextM[1]!.length >= baseIndent) {
              i++;
              continue;
            }
          }
          break;
        }
        const itemM = /^( *)([*+-]|\d+[.)])\s+(.*)$/.exec(curLine);
        if (!itemM || itemM[1]!.length < baseIndent) break;
        if (itemM[1]!.length > baseIndent) {
          // Attach nested list lines to the last item
          const subLines: string[] = [];
          while (i < lines.length) {
            const sl = lines[i]!;
            if (sl.trim().length === 0) break;
            const sm = /^( *)/.exec(sl);
            if ((sm?.[1]?.length ?? 0) <= baseIndent) break;
            subLines.push(sl.slice(baseIndent + 2));
            i++;
          }
          const nestedBlocks = parseMarkdownBlocks(subLines);
          if (items.length > 0) {
            items[items.length - 1]!.children.push(...nestedBlocks);
          }
          continue;
        }

        const itemOrdered = /\d/.test(itemM[2]![0]!);
        if (itemOrdered !== isOrdered) break;

        const itemFirstLine = itemM[3]!;
        i++;
        const continuation: string[] = [itemFirstLine];
        const nestedRaw: string[] = [];
        while (i < lines.length && lines[i]!.trim().length > 0) {
          const nextItem = /^( *)([*+-]|\d+[.)])\s+/.exec(lines[i]!);
          if (nextItem) {
            if (nextItem[1]!.length > baseIndent) {
              nestedRaw.push(lines[i]!.slice(baseIndent + 2));
              i++;
              continue;
            }
            break;
          }
          if (/^ {0,3}(?:#{1,6}\s|```|~~~|>)/.test(lines[i]!)) break;
          if (nestedRaw.length > 0) {
            nestedRaw.push(lines[i]!.slice(Math.min(lines[i]!.length, baseIndent + 2)));
          } else {
            continuation.push(lines[i]!.trim());
          }
          i++;
        }

        const liChildren: MNode[] = [...parseInlineMarkdown(`${continuation.join(' ')}\n`)];
        if (nestedRaw.length > 0) {
          liChildren.push(...parseMarkdownBlocks(nestedRaw));
        }
        items.push(el('li', {}, liChildren));
      }

      blocks.push(el(listTag, {}, items));
      continue;
    }

    // Setext Heading (`Title\n===` or `Title\n---`)
    if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]!)) {
      const level = lines[i + 1]!.trim().startsWith('=') ? 1 : 2;
      blocks.push(el(`h${level}`, {}, parseInlineMarkdown(`${trimmed}\n`)));
      i += 2;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const pl = lines[i]!;
      const pt = pl.trim();
      if (pt.length === 0) break;
      if (/^ {0,3}(?:#{1,6}\s|```|~~~|>|(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$|[*+-]\s|\d+[.)]\s)/.test(pl)) {
        break;
      }
      if (pl.includes('|') && i + 1 < lines.length && isGfmTableDelimiterRow(lines[i + 1]!)) {
        break;
      }
      if (/^ {0,3}(?:=+|-+)\s*$/.test(pl)) {
        // Turn current paragraph into Setext heading!
        const level = pt.startsWith('=') ? 1 : 2;
        blocks.push(el(`h${level}`, {}, parseInlineMarkdown(`${paraLines.join(' ')}\n`)));
        paraLines.length = 0;
        i++;
        break;
      }
      paraLines.push(pt);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(el('p', {}, parseInlineMarkdown(`${paraLines.join(' ')}\n`)));
    }
  }

  return blocks;
}

function buildMarkdownChapterByteRanges(
  rawBytes: Uint8Array,
  encoding: string,
  bomLength: number,
  fallbackTitle: string,
): { readonly docTitle: string; readonly chapters: TxtChapterIndexEntry[] } {
  const chapters: TxtChapterIndexEntry[] = [];
  const lineDecoder = new TextDecoder(encoding, { fatal: false });
  let firstH1: string | null = null;

  interface MdLine {
    byteStart: number;
    byteEnd: number;
    text: string;
    hLevel: 0 | 1 | 2;
    hTitle: string;
  }

  const lines: MdLine[] = [];
  let lineStart = bomLength;
  for (let i = bomLength; i <= rawBytes.byteLength; i++) {
    if (i === rawBytes.byteLength || rawBytes[i] === 0x0a) {
      if (i > lineStart || i < rawBytes.byteLength) {
        const lineEnd = i < rawBytes.byteLength ? i + 1 : i;
        const slice = rawBytes.subarray(lineStart, i);
        let decoded = lineDecoder.decode(slice);
        if (decoded.endsWith('\r')) decoded = decoded.slice(0, -1);
        lines.push({
          byteStart: lineStart,
          byteEnd: lineEnd,
          text: decoded,
          hLevel: 0,
          hTitle: '',
        });
        lineStart = lineEnd;
      }
    }
  }

  // Mark h1 / h2 outside fenced code blocks (`ARCHITECTURE.md` §4.7: split at `h1`/`h2`)
  let inFence: string | null = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]!;
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(l.text);
    if (fm) {
      const f = fm[1]![0]!;
      if (!inFence) inFence = f;
      else if (inFence === f) inFence = null;
      continue;
    }
    if (inFence) continue;

    const atx = /^ {0,3}(#{1,2})\s+(.*?)\s*#*\s*$/.exec(l.text);
    if (atx && atx[2]) {
      const level = atx[1]!.length as 1 | 2;
      const title = atx[2].trim();
      l.hLevel = level;
      l.hTitle = title;
      if (level === 1 && !firstH1) firstH1 = title;
      continue;
    }

    if (idx + 1 < lines.length && l.text.trim().length > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(lines[idx + 1]!.text)) {
      const level = lines[idx + 1]!.text.trim().startsWith('=') ? 1 : 2;
      const title = l.text.trim();
      l.hLevel = level;
      l.hTitle = title;
      if (level === 1 && !firstH1) firstH1 = title;
    }
  }

  const docTitle = firstH1 || fallbackTitle;
  if (lines.length === 0) {
    return {
      docTitle,
      chapters: [
        { index: 0, title: docTitle, byteStart: bomLength, byteEnd: rawBytes.byteLength, charCount: 0, hasHeadingLine: false },
      ],
    };
  }

  const splitPoints: Array<{ li: number; title: string }> = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx]!.hLevel === 1 || lines[idx]!.hLevel === 2) {
      splitPoints.push({ li: idx, title: lines[idx]!.hTitle });
    }
  }

  const emitSpan = (startLi: number, endLi: number, title: string) => {
    if (startLi >= endLi) return;
    let cur = startLi;
    let part = 1;
    let totalChars = 0;
    for (let k = startLi; k < endLi; k++) totalChars += lines[k]!.text.length + 1;
    const multiPart = totalChars > MAX_TXT_SECTION_CHARS;

    while (cur < endLi) {
      let acc = 0;
      let cut = cur;
      while (cut < endLi) {
        const len = lines[cut]!.text.length + 1;
        if (cut > cur && acc + len > MAX_TXT_SECTION_CHARS) break;
        acc += len;
        cut++;
      }
      chapters.push({
        index: chapters.length,
        title: multiPart ? `${title} (${part})` : title,
        byteStart: lines[cur]!.byteStart,
        byteEnd: lines[cut - 1]!.byteEnd,
        charCount: acc,
        hasHeadingLine: false,
      });
      cur = cut;
      part++;
    }
  };

  if (splitPoints.length === 0) {
    emitSpan(0, lines.length, docTitle);
  } else {
    if (splitPoints[0]!.li > 0) {
      const hasPreamble = lines.slice(0, splitPoints[0]!.li).some((l) => l.text.trim().length > 0);
      if (hasPreamble) {
        emitSpan(0, splitPoints[0]!.li, 'Introduction');
      }
    }
    for (let s = 0; s < splitPoints.length; s++) {
      const startLi = splitPoints[s]!.li;
      const endLi = s + 1 < splitPoints.length ? splitPoints[s + 1]!.li : lines.length;
      emitSpan(startLi, endLi, splitPoints[s]!.title);
    }
  }

  return { docTitle, chapters };
}

export async function inspectMarkdown(
  src: ByteSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  const detected = await detectTextEncoding(src);
  const rawBytes = src.readAll ? await src.readAll() : await src.read(0, src.size);
  const fallbackTitle = (hint.fileName.replace(/\\/g, '/').split('/').pop() ?? hint.fileName)
    .replace(/\.(?:md|markdown)$/i, '')
    .trim() || 'Untitled';

  const { docTitle, chapters } = buildMarkdownChapterByteRanges(
    rawBytes,
    detected.encoding,
    detected.bomLength,
    fallbackTitle,
  );

  const spine: SectionRef[] = chapters.map((ch) => ({
    index: ch.index,
    title: ch.title,
    linear: true,
    sizeHint: Math.max(1, ch.charCount),
  }));

  const toc: TocItem[] = chapters.map((ch) => ({
    title: ch.title,
    locator: { section: ch.index, offset: 0 },
    children: [],
  }));

  const meta: BookMeta = {
    title: docTitle,
    authors: [],
    language: null,
    identifier: null,
    format: 'md',
    direction: 'ltr',
    fixedLayout: false,
  };

  const index: TxtBookIndex = {
    kind: 'md',
    encoding: detected.encoding,
    meta,
    toc,
    spine,
    chapters,
  };

  return { meta, cover: null, index };
}

export async function openMarkdownSession(
  src: ByteSource,
  hint: BookOpenHint,
  preloadedIndex?: TxtBookIndex,
): Promise<BookSession> {
  const index = preloadedIndex ?? (await inspectMarkdown(src, { fileName: hint.fileName })).index as TxtBookIndex;
  const sectionCache = new LruCache<number, BuiltSectionUnits>(6);

  const loadUnits = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const cached = sectionCache.get(sectionIndex);
    if (cached) return cached;

    const ch = index.chapters[sectionIndex];
    if (!ch) throw new MiniBookError('not-found', `Markdown section ${sectionIndex} out of range`);

    const byteLen = Math.max(0, ch.byteEnd - ch.byteStart);
    const slice = byteLen > 0 ? await src.read(ch.byteStart, byteLen) : new Uint8Array(0);
    const mdText = decodeBytesWithEncoding(slice, index.encoding, 0);
    const bodyChildren = renderMarkdownToNodes(mdText);

    // Ensure headings carry deterministic anchor ids if needed
    for (const node of bodyChildren) {
      if (/^h[1-6]$/.test(node.tag) && !node.attrs['id']) {
        const slug = textContent(node)
          .trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, '-')
          .replace(/^-|-$/g, '');
        if (slug) node.attrs['id'] = slug;
      }
    }

    const built = buildSectionRenderUnits({
      sectionIndex,
      bodyChildren,
      css: '',
      lang: index.meta.language,
      dir: 'ltr',
      resources: [],
      isCoverLike: false,
    });
    sectionCache.set(sectionIndex, built);
    return built;
  };

  return {
    meta: index.meta,
    toc: index.toc as TocItem[],
    spine: index.spine,

    async loadSection(sectionIndex: number, unitIndex = 0): Promise<SectionDoc> {
      const built = await loadUnits(sectionIndex);
      const clamped = Math.max(0, Math.min(built.units.length - 1, unitIndex));
      return built.units[clamped]!;
    },

    async loadSectionUnits(sectionIndex: number): Promise<readonly SectionDoc[]> {
      return (await loadUnits(sectionIndex)).units;
    },

    async loadSectionText(sectionIndex: number): Promise<SectionText> {
      return (await loadUnits(sectionIndex)).fullText;
    },

    async loadResource(href: string): Promise<BookResource> {
      throw new MiniBookError('not-found', `Markdown book has no binary resource "${href}"`);
    },

    resolveHref(fromSection: number, href: string): ResolvedHref {
      const trimmed = href.trim();
      const ext = isRemoteOrExternalScheme(trimmed);
      if (ext) return { external: ext };
      if (trimmed.startsWith('#') || /^\d+#/.test(trimmed)) {
        return { section: fromSection, offset: 0 };
      }
      return null;
    },

    async cover(): Promise<CoverImage | null> {
      return null;
    },

    close(): void {
      sectionCache.clear();
    },
  };
}
