import { type BuiltSectionUnits, buildSectionRenderUnits } from '../../book/text-model.js';
import { MiniBookError } from '../../errors.js';
import { memoryByteSource } from '../../io/ByteSource.js';
import { concatBytes } from '../../io/binary.js';
import { decodeBytesWithEncoding, detectTextEncoding } from '../../io/encoding.js';
import { sanitizeXmlChars } from '../../markup/entities.js';
import { el, type MNode, txt } from '../../markup/mnode.js';
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
} from '../../types.js';
import { LruCache } from '../../util/lru.js';
import { buildStreamingTxtChapterIndex } from './chapters.js';

function inferLangFromEncodingAndSample(encoding: string, sampleText: string): string | null {
  const enc = encoding.toLowerCase();
  if (enc === 'gb18030') return 'zh-CN';
  if (enc === 'big5') return 'zh-TW';
  if (enc === 'shift_jis') return 'ja';
  if (enc === 'euc-kr') return 'ko';

  let kana = 0;
  let han = 0;
  let hangul = 0;
  let latin = 0;
  const limit = Math.min(sampleText.length, 2000);
  for (let i = 0; i < limit; i++) {
    const c = sampleText.charCodeAt(i);
    if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if (c >= 0xac00 && c <= 0xd7a3) hangul++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  if (kana > 5) return 'ja';
  if (hangul > 5) return 'ko';
  if (han > 10) return 'zh';
  if (latin > 10) return 'en';
  return null;
}

function deriveBookTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const stripped = base.replace(/\.[^.]+$/, '').trim();
  return stripped || 'Untitled';
}

/**
 * Transcodes UTF-16LE / UTF-16BE into UTF-8 in 1 MiB streaming chunks (`ARCHITECTURE.md` §4.6).
 */
async function transcodeUtf16ToDerivedUtf8(
  src: ByteSource,
  encoding: 'utf-16le' | 'utf-16be',
  bomLength: number,
  putDerived?: (name: string, chunk: Uint8Array) => Promise<void>,
): Promise<ByteSource> {
  const decoder = new TextDecoder(encoding, { fatal: false });
  const encoder = new TextEncoder();
  const memChunks: Uint8Array[] = [];
  const CHUNK = 1024 * 1024; // 1 MiB (even byte count)
  let offset = bomLength;

  while (offset < src.size) {
    const toRead = Math.min(CHUNK, src.size - offset);
    const raw = await src.read(offset, toRead);
    if (raw.byteLength === 0) break;
    offset += raw.byteLength;
    const isLast = offset >= src.size;
    const str = decoder.decode(raw, { stream: !isLast });
    const utf8 = encoder.encode(str);
    if (putDerived) {
      await putDerived('text.bin', utf8);
    }
    memChunks.push(utf8);
  }

  return memoryByteSource(concatBytes(memChunks));
}

function renderTxtLinesToNodes(rawSectionText: string, hasHeadingLine: boolean): MNode[] {
  const normalized = sanitizeXmlChars(rawSectionText);
  const lines = normalized.split('\n');
  const nodes: MNode[] = [];
  let blankRun = 0;
  let emittedContent = false;
  let headingConsumed = !hasHeadingLine;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Trim leading ideographic spaces (`\u3000`), tabs, and spaces (`ARCHITECTURE.md` §4.6)
    const trimmed = rawLine.replace(/^[\u3000\t ]+/, '').replace(/[\t ]+$/, '');
    if (trimmed.length === 0) {
      if (emittedContent) blankRun++;
      continue;
    }

    if (!headingConsumed) {
      headingConsumed = true;
      emittedContent = true;
      blankRun = 0;
      nodes.push(el('h2', {}, [txt(`${trimmed}\n`)]));
      continue;
    }

    if (blankRun >= 2 && emittedContent) {
      nodes.push(el('div', { class: 'mb-scene-break', 'aria-hidden': 'true' }, []));
    }
    blankRun = 0;
    emittedContent = true;
    nodes.push(el('p', {}, [txt(`${trimmed}\n`)]));
  }

  return nodes;
}

export async function inspectTxt(
  src: ByteSource,
  hint: BookInspectHint,
): Promise<InspectedBook> {
  const detected = await detectTextEncoding(src);
  let effectiveSrc = src;
  let effectiveEncoding = detected.encoding;
  let bomLength = detected.bomLength;
  let usesDerivedText = false;

  if (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be') {
    effectiveSrc = await transcodeUtf16ToDerivedUtf8(
      src,
      detected.encoding,
      detected.bomLength,
      hint.putDerived,
    );
    effectiveEncoding = 'utf-8';
    bomLength = 0;
    usesDerivedText = true;
  }

  const chapters = await buildStreamingTxtChapterIndex(effectiveSrc, effectiveEncoding, bomLength);
  const headBytes = await effectiveSrc.read(
    bomLength,
    Math.min(8192, Math.max(0, effectiveSrc.size - bomLength)),
  );
  const sampleStr = decodeBytesWithEncoding(headBytes, effectiveEncoding, 0);
  const language = inferLangFromEncodingAndSample(detected.encoding, sampleStr);
  const title = deriveBookTitleFromFileName(hint.fileName);

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
    title,
    authors: [],
    language,
    identifier: null,
    format: 'txt',
    direction: 'ltr',
    fixedLayout: false,
  };

  const index: TxtBookIndex = {
    kind: 'txt',
    encoding: effectiveEncoding,
    ...(usesDerivedText ? { usesDerivedText: true } : {}),
    meta,
    toc,
    spine,
    chapters,
  };

  return { meta, cover: null, index };
}

export async function openTxtSession(
  src: ByteSource,
  hint: BookOpenHint,
  preloadedIndex?: TxtBookIndex,
): Promise<BookSession> {
  let index = preloadedIndex;
  let effectiveSrc: ByteSource = src;

  if (!index) {
    const detected = await detectTextEncoding(src);
    let enc = detected.encoding;
    let bom = detected.bomLength;
    let usesDerived = false;
    if (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be') {
      const derived = hint.getDerived?.('text.bin');
      effectiveSrc = derived ?? (await transcodeUtf16ToDerivedUtf8(src, detected.encoding, detected.bomLength));
      enc = 'utf-8';
      bom = 0;
      usesDerived = true;
    }
    const chapters = await buildStreamingTxtChapterIndex(effectiveSrc, enc, bom);
    const headBytes = await effectiveSrc.read(bom, Math.min(8192, Math.max(0, effectiveSrc.size - bom)));
    const sampleStr = decodeBytesWithEncoding(headBytes, enc, 0);
    const language = inferLangFromEncodingAndSample(detected.encoding, sampleStr);
    const title = deriveBookTitleFromFileName(hint.fileName);
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
    index = {
      kind: 'txt',
      encoding: enc,
      ...(usesDerived ? { usesDerivedText: true } : {}),
      meta: {
        title,
        authors: [],
        language,
        identifier: null,
        format: 'txt',
        direction: 'ltr',
        fixedLayout: false,
      },
      toc,
      spine,
      chapters,
    };
  } else if (index.usesDerivedText) {
    const derived = hint.getDerived?.('text.bin');
    if (derived) {
      effectiveSrc = derived;
    } else {
      const detected = await detectTextEncoding(src);
      if (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be') {
        effectiveSrc = await transcodeUtf16ToDerivedUtf8(src, detected.encoding, detected.bomLength);
      }
    }
  }

  const sectionCache = new LruCache<number, BuiltSectionUnits>(6);

  const loadUnits = async (sectionIndex: number): Promise<BuiltSectionUnits> => {
    const hit = sectionCache.get(sectionIndex);
    if (hit) return hit;

    const ch = index!.chapters[sectionIndex];
    if (!ch) {
      throw new MiniBookError('not-found', `TXT chapter ${sectionIndex} out of range`);
    }
    const byteLen = Math.max(0, ch.byteEnd - ch.byteStart);
    const rawSlice = byteLen > 0 ? await effectiveSrc.read(ch.byteStart, byteLen) : new Uint8Array(0);
    const decoded = decodeBytesWithEncoding(rawSlice, index!.encoding, 0);
    const bodyChildren = renderTxtLinesToNodes(decoded, ch.hasHeadingLine);

    const built = buildSectionRenderUnits({
      sectionIndex,
      bodyChildren,
      css: '',
      lang: index!.meta.language,
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
      throw new MiniBookError('not-found', `Plain text book has no binary resource "${href}"`);
    },

    resolveHref(_fromSection: number, href: string): ResolvedHref {
      if (/^(?:https?:|mailto:)/i.test(href.trim())) {
        return { external: href.trim() };
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
