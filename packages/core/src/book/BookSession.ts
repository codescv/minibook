import { detectBookFormat } from '../formats/detect.js';
import { createEpubSession, inspectEpub } from '../formats/epub/epub.js';
import { inspectFb2, openFb2Session } from '../formats/fb2/fb2.js';
import { inspectMarkdown, openMarkdownSession } from '../formats/md/markdown.js';
import {
  inspectMobiOrKf8,
  inspectPalmDocTxt,
  openMobiOrKf8Session,
  openPalmDocTxtSession,
} from '../formats/mobi/mobi.js';
import { inspectTxt, openTxtSession } from '../formats/txt/txt.js';
import { WindowedByteSource } from '../io/ByteSource.js';
import type {
  BookIndex,
  BookInspectHint,
  BookOpenHint,
  BookSession,
  ByteSource,
  InspectedBook,
} from '../types.js';

function ensureWindowed(src: ByteSource): ByteSource {
  return src instanceof WindowedByteSource ? src : new WindowedByteSource(src);
}

/**
 * Import-time inspector (`ARCHITECTURE.md` §4):
 * Detects container by content magic, checks DRM & zip-bomb caps, extracts metadata & cover,
 * writes optional derived files (`text.bin` for MOBI/KF8 or UTF-16/PalmDOC TXT), and returns
 * a JSON-serializable `BookIndex` so reopening never re-scans or re-decompresses the book.
 */
export async function inspectBook(
  rawSrc: ByteSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  const src = ensureWindowed(rawSrc);
  const detected = await detectBookFormat(src, hint.fileName);

  switch (detected.kind) {
    case 'epub':
      return inspectEpub(src, detected.zip);
    case 'fb2-zip':
      return inspectFb2(src, hint.fileName, true, detected.zip);
    case 'fb2':
      return inspectFb2(src, hint.fileName, false);
    case 'mobi-pdb':
      return inspectMobiOrKf8(src, hint);
    case 'palmdoc-txt':
      return inspectPalmDocTxt(src, hint);
    case 'md':
      return inspectMarkdown(src, hint);
    case 'txt':
      return inspectTxt(src, hint);
  }
}

/**
 * Opens a uniform lazy `BookSession` over any supported format (`ARCHITECTURE.md` §4).
 * When `index` is supplied (normal runtime path), skips container re-scanning completely!
 */
export async function openBook(
  rawSrc: ByteSource,
  hint: BookOpenHint,
  index?: BookIndex,
): Promise<BookSession> {
  const src = ensureWindowed(rawSrc);
  const wrappedHint: BookOpenHint = hint.getDerived
    ? {
        fileName: hint.fileName,
        getDerived: (name) => {
          const d = hint.getDerived!(name);
          return d ? ensureWindowed(d) : null;
        },
      }
    : hint;

  if (index) {
    switch (index.kind) {
      case 'epub':
        return createEpubSession(src, index);
      case 'kf8':
      case 'mobi6':
        return openMobiOrKf8Session(src, wrappedHint, index);
      case 'fb2':
        return openFb2Session(src, wrappedHint.fileName, index);
      case 'md':
        return openMarkdownSession(src, wrappedHint, index);
      case 'txt': {
        if (index.usesDerivedText && !wrappedHint.getDerived?.('text.bin')) {
          const detected = await detectBookFormat(src, wrappedHint.fileName);
          if (detected.kind === 'palmdoc-txt') {
            return openPalmDocTxtSession(src, wrappedHint, index);
          }
        }
        return openTxtSession(src, wrappedHint, index);
      }
    }
  }

  const detected = await detectBookFormat(src, wrappedHint.fileName);
  switch (detected.kind) {
    case 'epub': {
      const { zip, index: epubIdx } = await (await import('../formats/epub/epub.js')).buildEpubIndex(
        src,
        detected.zip,
      );
      return createEpubSession(src, epubIdx, zip);
    }
    case 'fb2-zip':
      return openFb2Session(src, wrappedHint.fileName, undefined, detected.zip);
    case 'fb2':
      return openFb2Session(src, wrappedHint.fileName);
    case 'mobi-pdb':
      return openMobiOrKf8Session(src, wrappedHint);
    case 'palmdoc-txt':
      return openPalmDocTxtSession(src, wrappedHint);
    case 'md':
      return openMarkdownSession(src, wrappedHint);
    case 'txt':
      return openTxtSession(src, wrappedHint);
  }
}
