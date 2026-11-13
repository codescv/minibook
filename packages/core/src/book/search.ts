import type { BookSession, SearchHit, TocItem } from '../types.js';
import { throwIfAborted } from '../util/abort.js';

interface FoldedTextWithMap {
  readonly folded: string;
  /** Maps each UTF-16 code unit in `folded` back to its UTF-16 start offset in `original`, plus sentinel at `folded.length`. */
  readonly toOrig: Int32Array;
}

function foldCaseAndWidthWithMap(original: string): FoldedTextWithMap {
  const foldedParts: string[] = [];
  const offsets: number[] = [];

  for (let i = 0; i < original.length; ) {
    const cp = original.codePointAt(i)!;
    const charLen = cp > 0xffff ? 2 : 1;
    const rawChar = original.slice(i, i + charLen);
    const norm = rawChar.normalize('NFKC').toLowerCase();
    for (let k = 0; k < norm.length; k++) {
      offsets.push(i);
    }
    foldedParts.push(norm);
    i += charLen;
  }
  offsets.push(original.length);
  return {
    folded: foldedParts.join(''),
    toOrig: Int32Array.from(offsets),
  };
}

function buildSectionChapterMap(toc: readonly TocItem[]): Map<number, Array<{ offset: number; title: string }>> {
  const map = new Map<number, Array<{ offset: number; title: string }>>();
  const visit = (items: readonly TocItem[]) => {
    for (const item of items) {
      let arr = map.get(item.locator.section);
      if (!arr) {
        arr = [];
        map.set(item.locator.section, arr);
      }
      arr.push({ offset: item.locator.offset, title: item.title });
      if (item.children.length > 0) visit(item.children);
    }
  };
  visit(toc);
  for (const arr of map.values()) {
    arr.sort((a, b) => a.offset - b.offset);
  }
  return map;
}

function makeSearchSnippet(text: string, start: number, end: number): string {
  const ctxBefore = 28;
  const ctxAfter = 36;
  const sStart = Math.max(0, start - ctxBefore);
  const sEnd = Math.min(text.length, end + ctxAfter);
  const prefix = sStart > 0 ? '…' : '';
  const suffix = sEnd < text.length ? '…' : '';
  const raw = text.slice(sStart, sEnd).replace(/\s+/g, ' ').trim();
  return `${prefix}${raw}${suffix}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Streaming, case- and width-insensitive (`NFKC + toLowerCase()`) full-book search
 * (`ARCHITECTURE.md` §5.5). Yields to the event loop between sections and aborts cleanly on `signal`.
 */
export async function* search(
  session: BookSession,
  query: string,
  options?: { readonly signal?: AbortSignal; readonly maxHits?: number },
): AsyncGenerator<SearchHit, void, void> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return;

  const foldedQuery = trimmedQuery.normalize('NFKC').toLowerCase();
  if (!foldedQuery) return;

  const maxHits = options?.maxHits ?? 1000;
  let totalHits = 0;
  const tocMap = buildSectionChapterMap(session.toc);

  for (const sectionRef of session.spine) {
    throwIfAborted(options?.signal);
    if (!sectionRef.linear) continue;

    const sectionText = session.loadSectionText
      ? await session.loadSectionText(sectionRef.index)
      : (await session.loadSection(sectionRef.index)).text;

    throwIfAborted(options?.signal);

    if (sectionText.text.length > 0) {
      const { folded, toOrig } = foldCaseAndWidthWithMap(sectionText.text);
      const tocEntries = tocMap.get(sectionRef.index);
      let pos = 0;
      while (pos <= folded.length - foldedQuery.length) {
        const hitIdx = folded.indexOf(foldedQuery, pos);
        if (hitIdx < 0) break;

        const origStart = toOrig[hitIdx]!;
        const origEnd = toOrig[hitIdx + foldedQuery.length]!;
        const origLen = Math.max(1, origEnd - origStart);

        let chapterTitle = sectionRef.title;
        if (tocEntries && tocEntries.length > 0) {
          chapterTitle = tocEntries[0]!.title;
          for (const entry of tocEntries) {
            if (entry.offset <= origStart) chapterTitle = entry.title;
            else break;
          }
        }

        yield {
          locator: { section: sectionRef.index, offset: origStart },
          length: origLen,
          snippet: makeSearchSnippet(sectionText.text, origStart, origEnd),
          ...(chapterTitle !== undefined ? { chapterTitle } : {}),
        };

        totalHits++;
        if (totalHits >= maxHits) return;
        pos = hitIdx + Math.max(1, foldedQuery.length);
      }
    }

    await yieldToEventLoop();
  }
}

export const searchBook = search;
