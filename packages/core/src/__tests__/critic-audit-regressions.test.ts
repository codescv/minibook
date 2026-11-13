import { describe, expect, it } from 'vitest';
import {
  MiniBookError,
  buildZipArchive,
  inspectBook,
  memoryByteSource,
  openBook,
  parseHtmlDocument,
  parseXml,
  sanitizeStylesheet,
  search,
  segmentSection,
} from '../index.js';
import { buildSectionText } from '../book/text-model.js';
import { parseHtmlFragment } from '../markup/html.js';
import { readMobiIndxTable } from '../formats/mobi/indx.js';
import { encodeVarIntForwardForTest } from './mobi-indx-helper.js';

describe('Real-Book Adversarial Audit Regressions (#25)', () => {
  it('[P1-C1] reads INDX type at offset 12 and CNCX record count at offset 52 (u32@188 = 0)', async () => {
    // Build a two-level meta-INDX (`type = 2` at byte 12, `count = 1` leaf record at byte 24, `cncxCount = 1` at byte 52, `0` at byte 188!)
    const tagxOffset = 192;
    // Tag 3 = CNCX label offset (`numValues = 1, mask = 0x01`), end rule `(0, 0, 0, 1)`
    const tagx = new Uint8Array([
      0x54, 0x41, 0x47, 0x58, // 'TAGX'
      0, 0, 0, 20, // len = 20
      0, 0, 0, 1, // 1 control byte
      3, 1, 0x01, 0,
      0, 0, 0, 1,
    ]);
    const metaIndx = new Uint8Array(192 + tagx.length);
    const mv = new DataView(metaIndx.buffer);
    metaIndx.set(new TextEncoder().encode('INDX'), 0);
    mv.setUint32(4, 192, false);
    mv.setUint32(8, 0, false); // nul1 = 0
    mv.setUint32(12, 2, false); // type = 2 (two-level meta header!)
    mv.setUint32(20, 0, false);
    mv.setUint32(24, 1, false); // 1 leaf INDX record
    mv.setUint32(28, 65001, false); // UTF-8
    mv.setUint32(52, 1, false); // nctoc / cncxCount = 1 at offset 52!
    mv.setUint32(180, tagxOffset, false);
    mv.setUint32(188, 0, false); // u32@188 is 0 in real Gutenberg Kindle files!
    metaIndx.set(tagx, tagxOffset);

    // Build CNCX record with 2 real CJK chapter titles
    const title0 = new TextEncoder().encode('第一回 宴桃園豪傑三結義');
    const title1 = new TextEncoder().encode('第二回 張翼德怒鞭督郵');
    const len0 = encodeVarIntForwardForTest(title0.length);
    const len1 = encodeVarIntForwardForTest(title1.length);
    const off0 = 0;
    const off1 = len0.length + title0.length;
    const cncxRec = new Uint8Array(len0.length + title0.length + len1.length + title1.length);
    cncxRec.set(len0, 0);
    cncxRec.set(title0, len0.length);
    cncxRec.set(len1, off1);
    cncxRec.set(title1, off1 + len1.length);

    // Build leaf INDX record (`type = 0` at byte 12, `tagxOffset = 0` at byte 180) with labels `"00"`, `"01"`
    const e0Val = encodeVarIntForwardForTest(off0);
    const e1Val = encodeVarIntForwardForTest(off1);
    const entry0 = Uint8Array.from([2, 0x30, 0x30, 0x01, ...e0Val]); // label "00", ctrl 0x01, cncx off0
    const entry1 = Uint8Array.from([2, 0x30, 0x31, 0x01, ...e1Val]); // label "01", ctrl 0x01, cncx off1
    const e0Pos = 192;
    const e1Pos = e0Pos + entry0.length;
    let idxtPos = e1Pos + entry1.length;
    if (idxtPos % 2 === 1) idxtPos++;
    const leafRec = new Uint8Array(idxtPos + 8);
    const lv = new DataView(leafRec.buffer);
    leafRec.set(new TextEncoder().encode('INDX'), 0);
    lv.setUint32(4, 192, false);
    lv.setUint32(12, 0, false); // leaf type = 0
    lv.setUint32(20, idxtPos, false);
    lv.setUint32(24, 2, false); // 2 entries
    lv.setUint32(28, 65001, false);
    leafRec.set(entry0, e0Pos);
    leafRec.set(entry1, e1Pos);
    leafRec.set(new TextEncoder().encode('IDXT'), idxtPos);
    lv.setUint16(idxtPos + 4, e0Pos, false);
    lv.setUint16(idxtPos + 6, e1Pos, false);

    // Concatenate into a mock file with recordOffsets `[0, meta.len, meta.len + leaf.len]`
    const total = metaIndx.length + leafRec.length + cncxRec.length;
    const combined = new Uint8Array(total);
    combined.set(metaIndx, 0);
    combined.set(leafRec, metaIndx.length);
    combined.set(cncxRec, metaIndx.length + leafRec.length);

    const parsed = await readMobiIndxTable(
      memoryByteSource(combined),
      [0, metaIndx.length, metaIndx.length + leafRec.length],
      total,
      0,
    );
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.getCncxString(parsed.entries[0]?.tags[3]?.[0])).toBe('第一回 宴桃園豪傑三結義');
    expect(parsed.getCncxString(parsed.entries[1]?.tags[3]?.[0])).toBe('第二回 張翼德怒鞭督郵');
  });

  it('[P1-C2] resolves EPUB TOC entries with #fragment in a single XHTML file to exact non-zero Locator offsets', async () => {
    const filler = '<p>' + 'Quiet Penguin Classics prose across twenty thousand characters. '.repeat(320) + '</p>';
    const singleXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <h2 id="ch1">Chapter 1</h2>${filler}
  <h2 id="ch2">Chapter 2</h2>${filler}
  <h2 id="ch3">Chapter 3</h2>${filler}
  <h2 id="ch4">Chapter 4</h2>${filler}
  <h2 id="ch5">Chapter 5</h2>${filler}
</body>
</html>`;

    const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="t.xhtml#ch1">Chapter 1</a></li>
      <li><a href="t.xhtml#ch2">Chapter 2</a></li>
      <li><a href="t.xhtml#ch3">Chapter 3</a></li>
      <li><a href="t.xhtml#ch4">Chapter 4</a></li>
      <li><a href="t.xhtml#ch5">Chapter 5</a></li>
    </ol>
  </nav>
</body>
</html>`;

    const epubBytes = buildZipArchive([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      {
        name: 'META-INF/container.xml',
        data: '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">frag-toc</dc:identifier><dc:title>Single File Book</dc:title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="t"/></spine></package>',
      },
      { name: 'OEBPS/nav.xhtml', data: navXhtml },
      { name: 'OEBPS/t.xhtml', data: singleXhtml },
    ]);

    let coldReads = 0;
    const rawMem = memoryByteSource(epubBytes);
    const countingSrc = {
      size: rawMem.size,
      async read(offset: number, length: number) {
        coldReads++;
        return rawMem.read(offset, length);
      },
    };

    const session = await openBook(countingSrc, { fileName: 'single.epub' });
    expect(coldReads).toBeLessThanOrEqual(12);
    expect(session.toc).toHaveLength(5);

    // Before even calling `loadSection(0)`, `toc` AND `resolveHref` already agree on exact offsets!
    // (`\n  ` before `<h2 id="ch1">` is 3 counted chars, and `#ch4` is > 60,000 chars!)
    expect(session.toc[0]!.locator).toEqual({ section: 0, offset: 3 });
    expect(session.toc[3]!.locator.offset).toBeGreaterThan(60_000);
    expect(session.resolveHref(0, 't.xhtml#ch4')).toEqual(session.toc[3]!.locator);

    // After `loadSectionText(0)`, verify `text.slice(offset)` literally starts with `"Chapter 4"`!
    const fullText = await session.loadSectionText!(0);
    for (let k = 0; k < 5; k++) {
      const loc = session.toc[k]!.locator;
      expect(fullText.text.slice(loc.offset, loc.offset + 9)).toBe(`Chapter ${k + 1}`);
      expect(session.resolveHref(0, `t.xhtml#ch${k + 1}`)).toEqual(loc);
    }
  });

  it('[P1-C3] strips CSS hex-escaped \\75 rl(...) and image-set(...) remote URLs while rewriting local image-set URLs', async () => {
    const resources = new Set<string>();
    const maliciousCss = `
      .u { background: \\75 rl(http://evil.example/esc.png); }
      .u2 { background-image: \\000075rl("https://evil.example/esc2.png"); }
      .s { background-image: image-set("http://evil.example/is.png" 1x); }
      .w { background-image: -webkit-image-set('https://evil.example/wis.png' 2x); }
      .cf { background-image: cross-fade(url(http://evil.example/a.png), "http://evil.example/b.png"); }
      .ex { width: \\65 xpression(alert(1)); }
      .ok { background-image: image-set("../Images/ornament.png" type("image/png") 1x); color: #222; }
    `;

    const clean = await sanitizeStylesheet(maliciousCss, {
      basePath: 'OEBPS/Styles/main.css',
      resources,
    });

    expect(clean).not.toContain('evil.example');
    expect(clean).not.toContain('http:');
    expect(clean).not.toContain('https:');
    expect(clean).not.toContain('expression');
    expect(clean).toContain('mb-res:OEBPS/Images/ornament.png');
    expect(clean).toContain('type("image/png")');
    expect(resources.has('OEBPS/Images/ornament.png')).toBe(true);
  });

  it('[P2] drops SVG <style> content from SectionText, caps 3000-deep nesting with corrupt-book, handles Jan./p.m., expands sparse TOCs, and separates glued blocks in search', async () => {
    // 1. SVG `<style>` dropped with content + sparse TOC (1 license TOC entry for 6 linear chapters -> expanded to 6!)
    const chapters = Array.from({ length: 6 }, (_, idx) => ({
      name: `OEBPS/ch${idx + 1}.xhtml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body><h1>第${idx + 1}回 章回標題</h1><p>正文內容第${idx + 1}段。</p>
${
  idx === 0
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@import "http://evil.example/svg.css"; .box { fill: #000; }</style><title>Decorative SVG Title</title><rect class="box" width="10" height="10"/></svg>'
    : ''
}</body></html>`,
    }));

    const sparseTocEpub = buildZipArchive([
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      {
        name: 'META-INF/container.xml',
        data: '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">sparse</dc:identifier><dc:title>三國志演義</dc:title><dc:language>zh-TW</dc:language></metadata>
          <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            ${chapters.map((_, i) => `<item id="c${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}
          </manifest>
          <spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine>
        </package>`,
      },
      {
        // Sparse TOC: only 1 entry (`< 50%` of 6 linear chapters)!
        name: 'OEBPS/nav.xhtml',
        data: '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="ch6.xhtml">附錄版權</a></li></ol></nav></body></html>',
      },
      ...chapters,
    ]);

    const inspectedSparse = await inspectBook(memoryByteSource(sparseTocEpub), {
      fileName: 'sparse.epub',
    });
    expect(inspectedSparse.index.toc).toHaveLength(6);
    expect(inspectedSparse.index.toc[0]?.title).toBe('第1回 章回標題');
    expect(inspectedSparse.index.toc[4]?.title).toBe('第5回 章回標題');

    const sparseSession = await openBook(
      memoryByteSource(sparseTocEpub),
      { fileName: 'sparse.epub' },
      inspectedSparse.index,
    );
    const ch0 = await sparseSession.loadSection(0);
    // SVG `<style>` content is NOT rendered as book text or counted in `SectionText`!
    expect(ch0.text.text).not.toContain('@import');
    expect(ch0.text.text).not.toContain('evil.example');
    expect(ch0.text.text).not.toContain('Decorative SVG Title');
    expect(ch0.css).not.toContain('evil.example');
    expect(ch0.css).toContain('.box { fill: #000; }');

    // Glued block boundary search (`<h1>第1回 章回標題</h1><p>正文內容第1段。</p>` has no whitespace between `</h1>` and `<p>`):
    expect(ch0.text.text.trim()).toBe('第1回 章回標題正文內容第1段。');
    const gluedHits = [];
    for await (const h of search(sparseSession, '章回標題 正文內容')) {
      gluedHits.push(h);
    }
    expect(gluedHits).toHaveLength(6);
    expect(gluedHits[0]?.snippet).toContain('第1回 章回標題 正文內容第1段。');

    const falseGlueHits = [];
    for await (const h of search(sparseSession, '標題正文')) {
      falseGlueHits.push(h);
    }
    expect(falseGlueHits).toHaveLength(0);

    // 2. 3,000 deeply nested elements -> throws `MiniBookError('corrupt-book')` (never `RangeError`)!
    const deepXml = '<div>'.repeat(3000) + 'deep' + '</div>'.repeat(3000);
    expect(() => parseXml(deepXml)).toThrowError(MiniBookError);
    expect(() => parseXml(deepXml)).toThrowError(expect.objectContaining({ code: 'corrupt-book' }));
    expect(() => parseHtmlDocument(deepXml)).toThrowError(
      expect.objectContaining({ code: 'corrupt-book' }),
    );

    // 3. Segmenter month & `a.m.`/`p.m.` abbreviations
    const dateSt = buildSectionText(
      parseHtmlFragment('<p>We met at 5 p.m. on Jan. 3. He said wait until Oct. 12 at 8 a.m. Then leave.</p>'),
      'en',
    );
    const segs = segmentSection(0, dateSt, { bookLang: 'en' });
    expect(segs.map((s) => s.text)).toEqual([
      'We met at 5 p.m. on Jan. 3.',
      'He said wait until Oct. 12 at 8 a.m.',
      'Then leave.',
    ]);
  });
});
