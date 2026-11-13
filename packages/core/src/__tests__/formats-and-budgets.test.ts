import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HuffCdicDecoder,
  MAX_RENDER_UNIT_CHARS,
  MiniBookError,
  compressPalmDoc,
  decompressPalmDoc,
  fractionForLocator,
  inspectBook,
  locatorForFraction,
  memoryByteSource,
  openBook,
  parseXml,
  reanchorLocator,
  search,
  segmentSection,
  stripMobiTrailingEntries,
} from '../index.js';
import type { MElement, MNode } from '../markup/mnode.js';
import { CountingByteSource } from './io-zip-encoding.test.js';

const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../fixtures');

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

/**
 * Independent strict XML walker simulating the UI's `DOMParser('application/xhtml+xml')` + `TextMap`:
 *   1. Parses `<html xmlns="http://www.w3.org/1999/xhtml"><body>${xhtml}</body></html>` with `strict: true`.
 *   2. Verifies zero undeclared XML namespace prefixes exist anywhere in the tree.
 *   3. Walks text nodes in document order, skipping any `[data-mb-skip]` subtree.
 */
function walkEmittedXhtmlStrict(xhtml: string): string {
  const wrapped = `<html xmlns="http://www.w3.org/1999/xhtml"><body>${xhtml}</body></html>`;
  const root = parseXml(wrapped, { strict: true });

  const checkNamespacesAndWalk = (
    node: MNode,
    boundPrefixes: ReadonlySet<string>,
  ): string => {
    if (node.type === 'text') return node.value;
    const elem = node as MElement;

    const nextPrefixes = new Set(boundPrefixes);
    for (const k of Object.keys(elem.attrs)) {
      if (k.startsWith('xmlns:')) {
        nextPrefixes.add(k.slice('xmlns:'.length));
      }
    }
    for (const k of Object.keys(elem.attrs)) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
      const colon = k.indexOf(':');
      if (colon >= 0) {
        const prefix = k.slice(0, colon);
        expect(
          nextPrefixes.has(prefix),
          `Undeclared XML prefix "${prefix}:" in attribute "${k}" of <${elem.tag}>`,
        ).toBe(true);
      }
    }

    if ('data-mb-skip' in elem.attrs) return '';
    let acc = '';
    for (const c of elem.children) {
      acc += checkNamespacesAndWalk(c, nextPrefixes);
    }
    return acc;
  };

  return checkNamespacesAndWalk(root, new Set(['xml']));
}

const VALID_FIXTURE_FILES = [
  'epub2-classic.epub',
  'epub3-modern.epub',
  'epub3-adobe-rtl.epub',
  'kf8-sample.azw3',
  'mobi6-classic.mobi',
  'mobi-huffcdic.mobi',
  'mobi-combo.mobi',
  'sample-utf8.fb2',
  'sample-cp1251.fb2',
  'sample.fb2.zip',
  'txt-utf8-chapters.txt',
  'txt-utf8-bom.txt',
  'txt-gb18030.txt',
  'txt-big5.txt',
  'txt-sjis.txt',
  'txt-utf16le.txt',
  'sample.md',
] as const;

describe('Format Parsers, Call Budgets, I-TEXT Invariant & Adversarial Security', () => {
  it.each(VALID_FIXTURE_FILES)(
    'opens %s within <= 12 reads, loads sections within <= 3 reads, and satisfies I-TEXT + utterance slice invariant',
    async (fileName) => {
      const bytes = loadFixture(fileName);

      // 1. Import-time `inspectBook` (collecting optional `text.bin` derived chunks)
      const derivedChunks: Uint8Array[] = [];
      const inspected = await inspectBook(memoryByteSource(bytes), {
        fileName,
        putDerived: async (name, chunk) => {
          if (name === 'text.bin') derivedChunks.push(chunk);
        },
      });
      expect(inspected.meta.title.length).toBeGreaterThan(0);
      expect(inspected.index.spine.length).toBeGreaterThan(0);

      let derivedBytes: Uint8Array | null = null;
      if (derivedChunks.length > 0) {
        const total = derivedChunks.reduce((a, c) => a + c.byteLength, 0);
        derivedBytes = new Uint8Array(total);
        let off = 0;
        for (const ch of derivedChunks) {
          derivedBytes.set(ch, off);
          off += ch.byteLength;
        }
      }

      // 2. Runtime `openBook` over CountingByteSource (assert `open <= 12` reads!)
      const bookCounter = new CountingByteSource(bytes, { allowReadAll: false });
      const derivedCounter = derivedBytes
        ? new CountingByteSource(derivedBytes, { allowReadAll: false })
        : null;

      const session = await openBook(
        bookCounter,
        {
          fileName,
          getDerived: (name) => (name === 'text.bin' ? derivedCounter : null),
        },
        inspected.index,
      );

      const openReads = bookCounter.readCalls + (derivedCounter?.readCalls ?? 0);
      expect(openReads, `${fileName}: openBook read budget <= 12`).toBeLessThanOrEqual(12);

      // Also test cold `openBook` without pre-persisted `BookIndex` on non-MOBI containers
      if (!derivedBytes) {
        const coldCounter = new CountingByteSource(bytes, { allowReadAll: false });
        await openBook(coldCounter, { fileName });
        expect(coldCounter.readCalls, `${fileName}: cold openBook <= 12`).toBeLessThanOrEqual(12);
      }

      // 3. Load up to first 2 sections: assert `loadSection <= 3` reads + strict I-TEXT + TTS slice invariant!
      const sectionsToCheck = Math.min(2, session.spine.length);
      for (let sIdx = 0; sIdx < sectionsToCheck; sIdx++) {
        bookCounter.reset();
        derivedCounter?.reset();

        const doc = await session.loadSection(sIdx);
        const sectionReads = bookCounter.readCalls + (derivedCounter?.readCalls ?? 0);
        expect(
          sectionReads,
          `${fileName} section ${sIdx}: loadSection read budget <= 3`,
        ).toBeLessThanOrEqual(3);

        // Invariant I-TEXT (`ARCHITECTURE.md` §5.3):
        const walkedDomText = walkEmittedXhtmlStrict(doc.xhtml);
        expect(walkedDomText, `${fileName} section ${sIdx}: I-TEXT invariant`).toBe(doc.text.text);

        // Utterance 1-to-1 slice invariant (`u.text === doc.text.text.slice(u.start, u.end)`):
        const utterances = segmentSection(sIdx, doc.text, { bookLang: session.meta.language });
        for (const u of utterances) {
          expect(u.text).toBe(doc.text.text.slice(u.start, u.end));
        }
      }

      session.close();
    },
  );

  it('verifies EPUB 3 sibling stylesheet URL resolution, IDPF & Adobe font de-obfuscation, and ruby/noteref skipping', async () => {
    const session = await openBook(memoryByteSource(loadFixture('epub3-modern.epub')), {
      fileName: 'epub3-modern.epub',
    });

    // EPUB 3 `meta[@refines]` main title beats subtitle
    expect(session.meta.title).toBe('A Tale of Two Cities');
    expect(session.meta.authors).toEqual(['Charles Dickens']);
    expect(session.spine).toHaveLength(3);
    expect(session.spine[2]?.linear).toBe(false); // endnotes `linear="no"`

    const cover = await session.cover();
    expect(cover?.mime).toBe('image/png');
    expect(cover?.bytes.subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    const ch1 = await session.loadSection(0);
    // Sibling stylesheet `OEBPS/Styles/main.css` + `../Fonts/LiterataSub.woff2` -> `OEBPS/Fonts/LiterataSub.woff2`!
    expect(ch1.css).toContain('mb-res:OEBPS/Fonts/LiterataSub.woff2');
    // Nested `@import "sub/typo.css"` inside `OEBPS/Styles/` + `../../Images/ornament.png` -> `OEBPS/Images/ornament.png`!
    expect(ch1.css).toContain('mb-res:OEBPS/Images/ornament.png');
    // User-owned `!important` (`color: #111 !important`) stripped, `18px` normalized to `em`
    expect(ch1.css).not.toContain('!important');
    expect(ch1.css).toContain('1.125em');

    // Ruby `<rt>かんじ</rt>`, `<rp>`, `[1]` noteref, `(2)` sup, and pagebreak `2` are ALL skipped (`[data-mb-skip]`)!
    expect(ch1.text.text).toContain('日本語のルビ検証：漢字語と静かな読書。');
    expect(ch1.text.text).not.toContain('かんじ');
    expect(ch1.text.text).not.toContain('[1]');
    expect(ch1.text.text).not.toContain('(2)');

    // External link converted to `data-mb-ext`, internal footnote link converted to `data-mb-loc` targeting section 2!
    expect(ch1.xhtml).toContain('data-mb-ext="https://standardebooks.org"');
    expect(ch1.xhtml).toContain('data-mb-loc="2#fn1"');

    // IDPF SHA-1 font de-obfuscation restores valid `wOF2` header + payload!
    const fontRes = await session.loadResource('OEBPS/Fonts/LiterataSub.woff2');
    expect(fontRes.mime).toBe('font/woff2');
    expect(new TextDecoder().decode(fontRes.bytes.subarray(0, 4))).toBe('wOF2');
    expect(new TextDecoder().decode(fontRes.bytes.subarray(48, 70))).toContain('MINIBOOK-FONT-PAYLOAD');

    // Adobe UUID 1024-byte XOR font de-obfuscation + RTL metadata (`epub3-adobe-rtl.epub`)
    const rtlSession = await openBook(memoryByteSource(loadFixture('epub3-adobe-rtl.epub')), {
      fileName: 'epub3-adobe-rtl.epub',
    });
    expect(rtlSession.meta.direction).toBe('rtl');
    const adobeFont = await rtlSession.loadResource('OEBPS/Fonts/AdobeFont.woff2');
    expect(new TextDecoder().decode(adobeFont.bytes.subarray(0, 4))).toBe('wOF2');
    expect(new TextDecoder().decode(adobeFont.bytes.subarray(48, 70))).toContain('MINIBOOK-FONT-PAYLOAD');
  });

  it('assembles KF8 raw UTF-8 CJK skeletons + fragments accurately, resolves kindle:pos links, and inflates FONT records', async () => {
    const azw3Bytes = loadFixture('kf8-sample.azw3');
    const session = await openBook(memoryByteSource(azw3Bytes), { fileName: 'kf8-sample.azw3' });

    expect(session.meta.format).toBe('kf8');
    expect(session.meta.title).toBe('春江花月夜 · 唐诗选');
    expect(session.meta.authors).toEqual(['张若虚']);
    expect(session.meta.language).toBe('zh-CN');
    expect(session.toc.map((t) => t.title)).toEqual(['第一章 春江花月夜', '第二章 江天一色']);

    const sec0 = await session.loadSection(0);
    // Multi-byte UTF-8 CJK skeleton + 2 fragments assembled cleanly without cutting any character!
    expect(sec0.text.text).toContain('春江潮水连海平，海上明月共潮生。');
    expect(sec0.text.text).toContain('江流宛转绕芳甸，月照花林皆似霰；');
    expect(sec0.css).toContain('mb-res:kindle:embed:1'); // 0-based `0002 -> 1`

    // Cross-section `kindle:pos:fid:0002:off:0000000000` link points to Section 1 `#mb-pos-2-0`!
    expect(sec0.xhtml).toContain('data-mb-loc="1#mb-pos-2-0"');
    const resolved = session.resolveHref(0, 'kindle:pos:fid:0002:off:0000000000');
    expect(resolved).toEqual({ section: 1, offset: 0 });

    const sec1 = await session.loadSection(1);
    expect(sec1.xhtml).toContain('id="mb-pos-2-0"');
    expect(sec1.text.text).toContain('江天一色无纤尘，皎皎空中孤月轮。');

    // Resource 0 = PNG cover, Resource 1 = XOR + zlib compressed `FONT` record -> inflated `wOF2`!
    const img0 = await session.loadResource('kindle:embed:0');
    expect(img0.mime).toBe('image/png');
    const font1 = await session.loadResource('kindle:embed:1');
    expect(font1.mime).toBe('font/woff2');
    expect(new TextDecoder().decode(font1.bytes.subarray(0, 4))).toBe('wOF2');
  });

  it('handles PalmDOC LZ77 round-trips, HUFF/CDIC recursion guards, Combo MOBI7+KF8 fallback, and 20 MB coalesced import reads', async () => {
    // 1. PalmDOC round-trip with overlapping repetition & CJK UTF-8
    const sample = new TextEncoder().encode(
      'aaaaabbbbbcccccdddddeeeee The quick brown fox jumps over the lazy dog! 春江潮水连海平 '.repeat(8),
    );
    const compressed = compressPalmDoc(sample);
    expect(compressed.byteLength).toBeLessThan(sample.byteLength);
    expect(decompressPalmDoc(compressed)).toEqual(sample);

    // Trailing entries stripping: bit 1 (backward varint size = 4: `[0x11, 0x22, 0x33, 0x84]`) + bit 0 (overlap = 2: `[0xee, 0x01]`)
    const withTrailing = Uint8Array.from([0x41, 0x42, 0x43, 0xee, 0x01, 0x11, 0x22, 0x33, 0x84]);
    expect(stripMobiTrailingEntries(withTrailing, 0x03)).toEqual(Uint8Array.from([0x41, 0x42, 0x43]));

    // 2. HUFF/CDIC recursive expansion + depth > 32 cycle guard
    const huffSession = await openBook(memoryByteSource(loadFixture('mobi-huffcdic.mobi')), {
      fileName: 'mobi-huffcdic.mobi',
    });
    const huffSec = await huffSession.loadSection(0);
    expect(huffSec.text.text).toContain(
      'Recursive Huffman dictionary Recursive Huffman dictionary Recursive Huffman decompression in MiniBook.',
    );

    // Construct a cyclic non-literal CDIC entry (`entry 0` -> bit `1...` -> `entry 0` forever!) and assert depth-32 guard!
    const huffHdr = new Uint8Array(24 + 1024 + 256);
    const hv = new DataView(huffHdr.buffer);
    huffHdr.set(new TextEncoder().encode('HUFF'), 0);
    hv.setUint32(4, 24, false);
    hv.setUint32(8, 24, false);
    hv.setUint32(12, 1048, false);
    for (let i = 0; i < 256; i++) {
      // 1-bit code: `maxcode = 1`, `terminal = 1`, `codeLen = 1` -> top bit 1 maps to `1 - 1 = 0`!
      hv.setUint32(24 + i * 4, (1 << 8) | 0x80 | 1, false);
    }
    const cyclicCdic = new Uint8Array(16 + 2 + 3);
    const cv = new DataView(cyclicCdic.buffer);
    cyclicCdic.set(new TextEncoder().encode('CDIC'), 0);
    cv.setUint32(4, 16, false);
    cv.setUint32(8, 1, false);
    cv.setUint32(12, 10, false);
    cv.setUint16(16, 2, false);
    cv.setUint16(18, 0x0001, false); // NON-LITERAL (`0x8000` unset), length 1 byte
    cyclicCdic[20] = 0xff; // bit 1 -> self-references entry 0!
    const cyclicDecoder = new HuffCdicDecoder(huffHdr, [cyclicCdic]);
    expect(() => cyclicDecoder.decompress(Uint8Array.from([0xff]))).toThrowError(
      expect.objectContaining({ code: 'too-large' }),
    );

    // 3. Combo MOBI 7 + KF8: prefers KF8 when valid, falls back to MOBI 6 when KF8 skeleton is corrupt!
    const comboBytes = loadFixture('mobi-combo.mobi');
    const validCombo = await openBook(memoryByteSource(comboBytes), { fileName: 'mobi-combo.mobi' });
    expect(validCombo.meta.format).toBe('kf8');
    expect(validCombo.meta.title).toBe('Combo Edition (KF8 Preferred)');

    // Corrupt `"INDX"` of `skel` in the KF8 half (first INDX after `BOUNDARY`) and verify clean MOBI 6 fallback!
    const brokenComboBytes = comboBytes.slice();
    const asciiStr = new TextDecoder('iso-8859-1').decode(brokenComboBytes);
    const boundaryPos = asciiStr.indexOf('BOUNDARY');
    const skelPos = asciiStr.indexOf('INDX', boundaryPos);
    expect(skelPos).toBeGreaterThan(boundaryPos);
    brokenComboBytes[skelPos] = 0x58; // break `'INDX'` -> `'XNDX'`
    const fallbackCombo = await openBook(memoryByteSource(brokenComboBytes), {
      fileName: 'mobi-combo.mobi',
    });
    expect(fallbackCombo.meta.format).toBe('mobi');
    expect(fallbackCombo.meta.title).toBe('Combo Edition (MOBI6 Fallback Title)');
    const fbSec0 = await fallbackCombo.loadSection(0);
    expect(fbSec0.text.text).toContain('To Sherlock Holmes she is always the woman.');

    // 4. 20 MB MOBI import coalescing test (`<= 25` ranged reads instead of 5,120 4-KiB calls!)
    const recCount = 5120; // 5120 * 4096 = 20 MiB!
    const pdbHdrSize = 78 + (recCount + 1) * 8 + 2;
    const rec0 = new Uint8Array(280);
    const r0v = new DataView(rec0.buffer);
    r0v.setUint16(0, 1, false); // uncompressed for fast fixture construction
    r0v.setUint32(4, recCount * 4096, false);
    r0v.setUint16(8, recCount, false);
    r0v.setUint16(10, 4096, false);
    r0v.setUint16(12, 0, false);
    rec0.set(new TextEncoder().encode('MOBI'), 16);
    r0v.setUint32(20, 248, false);
    r0v.setUint32(28, 65001, false);
    r0v.setUint32(36, 6, false);
    for (let off = 40; off < 264; off += 4) {
      if (off !== 92 && off !== 128 && off !== 240) r0v.setUint32(off, 0xffffffff, false);
    }

    const total20Mb = pdbHdrSize + rec0.byteLength + recCount * 4096;
    const bigMobi = new Uint8Array(total20Mb);
    bigMobi.set(new TextEncoder().encode('BigMobiTest'), 0);
    bigMobi.set(new TextEncoder().encode('BOOKMOBI'), 60);
    const pView = new DataView(bigMobi.buffer);
    pView.setUint16(76, recCount + 1, false);

    let recOffset = pdbHdrSize;
    pView.setUint32(78, recOffset, false);
    bigMobi.set(rec0, recOffset);
    recOffset += rec0.byteLength;

    const block4k = new Uint8Array(4096).fill(0x61); // 'a'
    block4k.set(new TextEncoder().encode('<p>Twenty megabyte coalesced read test.</p>\n'), 0);
    for (let i = 1; i <= recCount; i++) {
      pView.setUint32(78 + i * 8, recOffset, false);
      bigMobi.set(block4k, recOffset);
      recOffset += 4096;
    }

    const bigCounter = new CountingByteSource(bigMobi, { allowReadAll: false });
    let derivedFlushes = 0;
    let derivedBytesTotal = 0;
    await inspectBook(bigCounter, {
      fileName: 'twenty-mb.mobi',
      putDerived: async (_name, chunk) => {
        derivedFlushes++;
        derivedBytesTotal += chunk.byteLength;
        expect(chunk.byteLength).toBeLessThanOrEqual(1024 * 1024 + 4096);
      },
    });
    expect(derivedBytesTotal).toBe(recCount * 4096);
    expect(derivedFlushes).toBeGreaterThanOrEqual(20);
    // 20 MiB at 1 MiB coalesced reads + header/table = ~22 calls (NEVER 5,120 calls!)
    expect(bigCounter.readCalls).toBeLessThanOrEqual(25);
  });

  it('supports FB2 (UTF-8, windows-1251, .fb2.zip, footnotes), Markdown GFM, virtual 40k splitting, Locator & NFKC Search', async () => {
    // FB2 windows-1251 Cyrillic
    const cp1251Session = await openBook(memoryByteSource(loadFixture('sample-cp1251.fb2')), {
      fileName: 'sample-cp1251.fb2',
    });
    expect(cp1251Session.meta.title).toBe('Пиковая дама');
    expect(cp1251Session.meta.authors).toEqual(['Александр Пушкин']);
    const ruSec = await cp1251Session.loadSection(0);
    expect(ruSec.text.text).toContain('Однажды играли в карты у конногвардейца Нарумова.');

    // FB2 UTF-8 footnotes (`linear: false`) & on-demand binary cover
    const fb2Session = await openBook(memoryByteSource(loadFixture('sample-utf8.fb2')), {
      fileName: 'sample-utf8.fb2',
    });
    expect(fb2Session.spine).toHaveLength(3);
    expect(fb2Session.spine[2]?.linear).toBe(false);
    const fb2Cover = await fb2Session.cover();
    expect(fb2Cover?.mime).toBe('image/png');
    const fb2Sec0 = await fb2Session.loadSection(0);
    expect(fb2Sec0.text.text).not.toContain('[1]'); // `type="note"` skipped!
    expect(fb2Sec0.xhtml).toContain('data-mb-loc="2#n1"');

    // Markdown GFM table & escaped raw `<script>`
    const mdSession = await openBook(memoryByteSource(loadFixture('sample.md')), {
      fileName: 'sample.md',
    });
    expect(mdSession.spine).toHaveLength(2); // split at `#` and `##`
    const mdSec0 = await mdSession.loadSection(0);
    expect(mdSec0.xhtml).not.toContain('<script>');
    expect(mdSec0.xhtml).toContain('&lt;script&gt;');
    const mdSec1 = await mdSession.loadSection(1);
    expect(mdSec1.xhtml).toContain('<table>');
    expect(mdSec1.xhtml).toContain('<pre><code class="language-ts">');

    // Virtual sectioning (`> 40,000` chars) in a giant single-chapter EPUB
    const bigParas = Array.from(
      { length: 480 },
      (_, i) => `<p>Paragraph ${i + 1}: ${'calm editorial reading typography '.repeat(6)}.</p>`,
    ).join('\n');
    const { buildZipArchive } = await import('../io/zip.js');
    const giantSingleFileEpub = buildZipArchive([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      {
        name: 'META-INF/container.xml',
        data: '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'content.opf',
        data: '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">1</dc:identifier><dc:title>Long Chapter</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      },
      {
        name: 'c1.xhtml',
        data: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div>${bigParas}</div></body></html>`,
      },
    ]);

    const longSession = await openBook(memoryByteSource(giantSingleFileEpub), {
      fileName: 'long.epub',
    });
    const fullSecText = await longSession.loadSectionText!(0);
    expect(fullSecText.text.length).toBeGreaterThan(95_000);

    const units = await longSession.loadSectionUnits!(0);
    expect(units.length).toBe(3);
    let reconcat = '';
    for (const u of units) {
      expect(u.text.text.length).toBeLessThanOrEqual(MAX_RENDER_UNIT_CHARS);
      expect(walkEmittedXhtmlStrict(u.xhtml)).toBe(u.text.text);
      reconcat += u.text.text;
    }
    expect(reconcat).toBe(fullSecText.text);

    // Locator fraction, inverse fraction, re-anchoring & NFKC width/case-folded search
    const frac = fractionForLocator(longSession.spine, { section: 0, offset: 45_000 }, fullSecText.text.length);
    expect(frac).toBeGreaterThan(0.4);
    expect(frac).toBeLessThan(0.6);
    const approxLoc = locatorForFraction(longSession.spine, 0.5);
    expect(approxLoc.section).toBe(0);

    const p242Offset = fullSecText.text.indexOf('Paragraph 242:');
    expect(p242Offset).toBeGreaterThan(40_000);
    const snippet = fullSecText.text.slice(p242Offset, p242Offset + 32);
    // Simulate edited edition shifted by +350 chars
    const shiftedText = { text: 'X'.repeat(350) + fullSecText.text, blocks: [] };
    expect(reanchorLocator(shiftedText, { offset: p242Offset, snippet, fraction: 0.5 })).toBe(
      p242Offset + 350,
    );

    // Fullwidth NFKC query `"ＰＡＲＡＧＲＡＰＨ 42:"` matches exact ASCII offset in `fullSecText`!
    const hits = [];
    for await (const hit of search(longSession, 'ＰＡＲＡＧＲＡＰＨ 42:', { maxHits: 5 })) {
      hits.push(hit);
    }
    expect(hits).toHaveLength(1);
    expect(
      fullSecText.text.slice(hits[0]!.locator.offset, hits[0]!.locator.offset + hits[0]!.length),
    ).toBe('Paragraph 42:');
  });

  it('neutralizes every XSS, XXE, remote tracking URL, and CSS attack vector, and maps DRM/unsupported formats accurately', async () => {
    const xssSession = await openBook(memoryByteSource(loadFixture('adversarial-xss.epub')), {
      fileName: 'adversarial-xss.epub',
    });
    const doc = await xssSession.loadSection(0);

    // Zero dangerous elements, attributes, schemes, or remote URLs survive!
    expect(doc.xhtml).not.toMatch(/<script/i);
    expect(doc.xhtml).not.toMatch(/<iframe/i);
    expect(doc.xhtml).not.toMatch(/<form|<input|<button/i);
    expect(doc.xhtml).not.toMatch(/<foreignobject|<animate/i);
    expect(doc.xhtml).not.toMatch(/\bon\w+\s*=/i);
    expect(doc.xhtml).not.toMatch(/javascript:|vbscript:/i);
    expect(doc.xhtml).not.toMatch(/evil\.example/i);
    expect(doc.css).not.toMatch(/evil\.example|expression\(|-moz-binding|@page|column-count|vertical-rl|!important/i);
    expect(doc.css).toContain('position: static');
    expect(doc.xhtml).toContain('position: static');
    expect(doc.text.text).toContain('Safe Surviving Heading');
    expect(doc.text.text).toContain('Clean paragraph text survives.');
    expect(walkEmittedXhtmlStrict(doc.xhtml)).toBe(doc.text.text);

    // DRM EPUB, DRM MOBI, KFX DRMION -> `drm-protected`
    await expect(
      inspectBook(memoryByteSource(loadFixture('adversarial-drm-epub.epub')), {
        fileName: 'drm.epub',
      }),
    ).rejects.toMatchObject({ code: 'drm-protected' });

    await expect(
      inspectBook(memoryByteSource(loadFixture('adversarial-drm-mobi.azw3')), {
        fileName: 'drm.azw3',
      }),
    ).rejects.toMatchObject({ code: 'drm-protected' });

    await expect(
      inspectBook(memoryByteSource(new Uint8Array([0xea, ...new TextEncoder().encode('DRMION00')])), {
        fileName: 'book.kfx',
      }),
    ).rejects.toMatchObject({ code: 'drm-protected' });

    // Unsupported formats: PDF, RAR, KFX `CONT` -> `unsupported-format`
    for (const [magic, fname] of [
      ['%PDF-1.7\n...', 'doc.pdf'],
      ['Rar!\x1a\x07\x00', 'comic.cbr'],
      ['CONT\x00\x02\x00\x00', 'book.kfx'],
    ] as const) {
      await expect(
        inspectBook(memoryByteSource(new TextEncoder().encode(magic)), { fileName: fname }),
      ).rejects.toMatchObject({ code: 'unsupported-format' });
    }
    expect(MiniBookError).toBeDefined();
  });
});
