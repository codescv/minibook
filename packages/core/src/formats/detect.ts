import { MiniBookError } from '../errors.js';
import { BinaryReader } from '../io/binary.js';
import { decodeBytesWithEncoding } from '../io/encoding.js';
import { ZipArchive } from '../io/zip.js';
import { sniffXmlDeclarationEncoding } from '../markup/xml-tokenizer.js';
import type { ByteSource } from '../types.js';

export type DetectedContainerKind =
  | 'epub'
  | 'fb2-zip'
  | 'mobi-pdb'
  | 'palmdoc-txt'
  | 'fb2'
  | 'md'
  | 'txt';

export interface DetectionResult {
  readonly kind: DetectedContainerKind;
  readonly zip?: ZipArchive;
}

function startsWithAscii(bytes: Uint8Array, sig: string, offset = 0): boolean {
  if (offset + sig.length > bytes.byteLength) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

function isBinaryControlNoise(head: Uint8Array): boolean {
  if (head.byteLength === 0) return false;
  // Allow UTF-16 BOM or alternating null bytes (BOM-less UTF-16)
  if (
    head.byteLength >= 2 &&
    ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))
  ) {
    return false;
  }
  const n = Math.min(head.byteLength & ~1, 512);
  if (n >= 16) {
    let evenZero = 0;
    let oddZero = 0;
    const pairs = n >>> 1;
    for (let i = 0; i < n; i += 2) {
      if (head[i] === 0) evenZero++;
      if (head[i + 1] === 0) oddZero++;
    }
    if (
      (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) ||
      (evenZero > pairs * 0.3 && oddZero < pairs * 0.05)
    ) {
      return false;
    }
  }

  let nullsAndControls = 0;
  const checkLen = Math.min(head.byteLength, 1024);
  for (let i = 0; i < checkLen; i++) {
    const b = head[i]!;
    if (b === 0 || (b < 0x09) || (b > 0x0d && b < 0x1b && b !== 0x1a)) {
      nullsAndControls++;
    }
  }
  return nullsAndControls > Math.max(2, checkLen * 0.05);
}

function looksLikeFictionBookXml(head: Uint8Array): boolean {
  const xmlEnc = sniffXmlDeclarationEncoding(head) ?? 'utf-8';
  const text = decodeBytesWithEncoding(head, xmlEnc);
  // Strip BOM, XML decl, comments, DOCTYPE
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trimStart();
  return /^<(?:[a-zA-Z0-9_]+:)?FictionBook[\s>]/i.test(stripped);
}

/**
 * Content-first format detection (`ARCHITECTURE.md` §4.1).
 * Uses file extension ONLY as a tie-breaker between Markdown and plain TXT.
 */
export async function detectBookFormat(
  src: ByteSource,
  fileName: string,
): Promise<DetectionResult> {
  if (src.size === 0) {
    // Empty text/markdown files are valid empty documents; empty `.epub`/`.azw3`/`.mobi` are corrupt
    const lowerEmpty = fileName.toLowerCase();
    if (/\.(?:epub|azw3|azw|mobi|prc|fb2)$/i.test(lowerEmpty)) {
      throw new MiniBookError('corrupt-book', 'Book file is empty (0 bytes).');
    }
    return { kind: /\.(?:md|markdown)$/i.test(lowerEmpty) ? 'md' : 'txt' };
  }

  const head = await src.read(0, Math.min(src.size, 4096));

  // 1. Explicit unsupported / DRM container signatures (`§4.1`)
  if (startsWithAscii(head, '%PDF-')) {
    throw new MiniBookError('unsupported-format', 'PDF files are not supported.');
  }
  if (startsWithAscii(head, 'Rar!')) {
    throw new MiniBookError('unsupported-format', 'RAR / CBR archives are not supported.');
  }
  if (head.byteLength >= 7 && head[0] === 0xea && startsWithAscii(head, 'DRMION', 1)) {
    throw new MiniBookError('drm-protected', 'This book is copy-protected (Kindle KFX DRM) and cannot be opened.');
  }
  if (startsWithAscii(head, 'CONT')) {
    throw new MiniBookError('unsupported-format', 'Kindle KFX format is not supported.');
  }
  if (startsWithAscii(head, 'TPZ')) {
    throw new MiniBookError('unsupported-format', 'Kindle Topaz format is not supported.');
  }
  if (
    (head.byteLength >= 6 && head[0] === 0x37 && head[1] === 0x7a && head[2] === 0xbc && head[3] === 0xaf) ||
    startsWithAscii(head, 'SQLite format 3') ||
    (head.byteLength >= 8 && startsWithAscii(head, 'ftyp', 4)) ||
    (head.byteLength >= 4 && head[0] === 0x89 && startsWithAscii(head, 'PNG', 1)) ||
    (head.byteLength >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
  ) {
    throw new MiniBookError('unsupported-format', 'Not a readable book format.');
  }

  // 2. PKZIP container (`PK\x03\x04` or empty `PK\x05\x06`)
  if (
    head.byteLength >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06))
  ) {
    const zip = await ZipArchive.open(src);
    if (zip.hasEntry('META-INF/container.xml')) {
      return { kind: 'epub', zip };
    }
    const mimeEntry = zip.findEntry('mimetype');
    if (mimeEntry) {
      const mimeText = (await zip.readText(mimeEntry, 256)).trim();
      if (mimeText === 'application/epub+zip') {
        return { kind: 'epub', zip };
      }
    }
    const fb2Entries = zip.entries.filter((e) => e.name.toLowerCase().endsWith('.fb2'));
    if (fb2Entries.length >= 1) {
      return { kind: 'fb2-zip', zip };
    }
    throw new MiniBookError('unsupported-format', 'ZIP archive is not an EPUB or zipped FB2 book.');
  }

  // 3. PalmDB / MOBI / AZW3 / PalmDOC (`bytes 60..67`)
  if (head.byteLength >= 68) {
    const r = new BinaryReader(head);
    const pdbMagic = r.asciiAt(60, 8);
    if (pdbMagic === 'BOOKMOBI') {
      return { kind: 'mobi-pdb' };
    }
    if (pdbMagic === 'TEXtREAd') {
      return { kind: 'palmdoc-txt' };
    }
    if (pdbMagic === 'BOOKMTIT' || pdbMagic === 'PNRdPPrs') {
      throw new MiniBookError('unsupported-format', `Unsupported Palm e-book type (${pdbMagic}).`);
    }
  }

  // 4. FictionBook 2 XML (`<FictionBook>`)
  if (looksLikeFictionBookXml(head)) {
    return { kind: 'fb2' };
  }

  // 5. Reject arbitrary binary data masquerading with a book extension
  if (isBinaryControlNoise(head)) {
    const lowerName = fileName.toLowerCase();
    if (/\.(?:epub|azw3|azw|mobi|prc)$/i.test(lowerName)) {
      throw new MiniBookError('corrupt-book', 'Truncated or corrupt binary book header.');
    }
    throw new MiniBookError('unsupported-format', 'Binary file is not a readable book.');
  }

  // 6. Plain decodable text: `.md` / `.markdown` -> Markdown, else TXT
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return { kind: 'md' };
  }
  return { kind: 'txt' };
}
