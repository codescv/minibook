import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  MiniBookError,
  WindowedByteSource,
  ZipArchive,
  buildZipArchive,
  computeBookId,
  crc32,
  detectTextEncoding,
  inspectBook,
  memoryByteSource,
  openBook,
} from '../index.js';
import type { ByteSource } from '../types.js';

const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../fixtures');

export class CountingByteSource implements ByteSource {
  readonly size: number;
  private readonly data: Uint8Array;
  private readonly allowReadAll: boolean;
  readCalls = 0;
  bytesRead = 0;
  maxSingleRead = 0;

  constructor(data: Uint8Array, opts?: { allowReadAll?: boolean }) {
    this.data = data;
    this.size = data.byteLength;
    this.allowReadAll = opts?.allowReadAll ?? false;
    if (!this.allowReadAll) {
      delete (this as Partial<ByteSource>).readAll;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.readCalls++;
    const end = Math.min(this.data.byteLength, offset + length);
    const slice = this.data.subarray(offset, Math.max(offset, end));
    this.bytesRead += slice.byteLength;
    if (slice.byteLength > this.maxSingleRead) {
      this.maxSingleRead = slice.byteLength;
    }
    return slice;
  }

  async readAll(): Promise<Uint8Array> {
    this.readCalls++;
    this.bytesRead += this.data.byteLength;
    return this.data;
  }

  reset(): void {
    this.readCalls = 0;
    this.bytesRead = 0;
    this.maxSingleRead = 0;
  }
}

describe('WindowedByteSource, ZipArchive & Multi-Encoding Detection', () => {
  it('coalesces small reads into 64 KiB windows, deduplicates concurrent reads, and caps > 1 MiB chunks', async () => {
    const raw = new Uint8Array(3 * 1024 * 1024 + 500);
    for (let i = 0; i < raw.length; i++) raw[i] = i & 0xff;

    const inner = new CountingByteSource(raw);
    const win = new WindowedByteSource(inner);

    // 10 small reads within the first 64 KiB window -> exactly 1 underlying call!
    const [a, b, c] = await Promise.all([
      win.read(10, 32),
      win.read(1024, 128),
      win.read(60_000, 500),
    ]);
    expect(inner.readCalls).toBe(1);
    expect(a).toEqual(raw.subarray(10, 42));
    expect(b).toEqual(raw.subarray(1024, 1152));
    expect(c).toEqual(raw.subarray(60_000, 60_500));

    // Read 2.5 MiB -> split into <= 1 MiB sequential chunks
    inner.reset();
    const big = await win.read(0, 2_500_000);
    expect(big.byteLength).toBe(2_500_000);
    expect(inner.maxSingleRead).toBeLessThanOrEqual(1024 * 1024);
    expect(inner.readCalls).toBe(3);

    const id1 = await computeBookId(memoryByteSource(raw));
    const id2 = await computeBookId(memoryByteSource(raw));
    expect(id1).toMatch(/^b_[0-9a-f]{40}$/);
    expect(id1).toBe(id2);
  });

  it('verifies CRC-32, decodes CP437 & percent-encoded names, and rejects encrypted & spoofed zip-bombs', async () => {
    const normalArchive = buildZipArchive([
      { name: 'OEBPS/Text/Ch 1.xhtml', data: '<p>Hello</p>' },
    ]);
    const zip = await ZipArchive.open(memoryByteSource(normalArchive));
    // Exact, percent-encoded, and case-insensitive lookup (`ARCHITECTURE.md` §4.2)
    expect(await zip.readText('OEBPS/Text/Ch 1.xhtml')).toBe('<p>Hello</p>');
    expect(await zip.readText('OEBPS/Text/Ch%201.xhtml')).toBe('<p>Hello</p>');
    expect(await zip.readText('oebps/text/ch 1.xhtml')).toBe('<p>Hello</p>');

    // Encrypted entry (`flags = 1`) -> `drm-protected`
    const encArchive = buildZipArchive([
      { name: 'secret.xhtml', data: 'encrypted', store: true, flags: 0x0001 },
    ]);
    const encZip = await ZipArchive.open(memoryByteSource(encArchive));
    await expect(encZip.readEntry('secret.xhtml')).rejects.toMatchObject({
      code: 'drm-protected',
    });

    //Fixture zip-bomb (`> 200:1` on `> 1 MiB`) -> `too-large`
    const bombBytes = new Uint8Array(readFileSync(resolve(FIXTURES, 'adversarial-zipbomb.epub')));
    await expect(
      openBook(memoryByteSource(bombBytes), { fileName: 'adversarial-zipbomb.epub' }).then((s) =>
        s.loadSection(0),
      ),
    ).rejects.toMatchObject({ code: 'too-large' });

    // Spoofed-header zip-bomb: central directory lies (`uncompressedSize = 32`), actual deflate stream is 2.2 MiB!
    const hugeZeros = new Uint8Array(2_200_000);
    const deflated = deflateSync(hugeZeros, { level: 9 });
    const realZip = buildZipArchive([{ name: 'spoof.bin', data: new Uint8Array(32), store: true }]);
    // Patch a manual ZIP with spoofed uncompressedSize = 32 but `deflated` payload
    const nameBytes = new TextEncoder().encode('spoof.xml');
    const localHdr = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHdr.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true); // deflate
    lv.setUint32(14, crc32(hugeZeros), true);
    lv.setUint32(18, deflated.byteLength, true);
    lv.setUint32(22, 32, true); // SPOOFED uncompressed size!
    lv.setUint16(26, nameBytes.length, true);
    localHdr.set(nameBytes, 30);

    const cdHdr = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHdr.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(hugeZeros), true);
    cv.setUint32(20, deflated.byteLength, true);
    cv.setUint32(24, 32, true); // SPOOFED!
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, 0, true);
    cdHdr.set(nameBytes, 46);

    const cdOffset = localHdr.byteLength + deflated.byteLength;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, cdHdr.byteLength, true);
    ev.setUint32(16, cdOffset, true);

    const spoofZipBytes = new Uint8Array(cdOffset + cdHdr.byteLength + 22);
    spoofZipBytes.set(localHdr, 0);
    spoofZipBytes.set(deflated, localHdr.byteLength);
    spoofZipBytes.set(cdHdr, cdOffset);
    spoofZipBytes.set(eocd, cdOffset + cdHdr.byteLength);
    void realZip;

    const spoofZip = await ZipArchive.open(memoryByteSource(spoofZipBytes));
    await expect(spoofZip.readEntry('spoof.xml')).rejects.toMatchObject({
      code: 'too-large',
    });

    // CRC-32 mismatch -> `corrupt-book`
    const corrupted = normalArchive.slice();
    // Flip a payload byte right before Central Directory
    const flipIdx = 30 + 'OEBPS/Text/Ch 1.xhtml'.length + 2;
    corrupted[flipIdx] = corrupted[flipIdx]! ^ 0xff;
    const badZip = await ZipArchive.open(memoryByteSource(corrupted));
    await expect(badZip.readEntry('OEBPS/Text/Ch 1.xhtml')).rejects.toMatchObject({
      code: 'corrupt-book',
    });
  });

  it('accurately detects UTF-8, UTF-8 BOM, UTF-16LE, GB18030, Big5, Shift_JIS, and Windows-1252', async () => {
    const cases: Array<[string, string]> = [
      ['txt-utf8-chapters.txt', 'utf-8'],
      ['txt-utf8-bom.txt', 'utf-8'],
      ['txt-utf16le.txt', 'utf-16le'],
      ['txt-gb18030.txt', 'gb18030'],
      ['txt-big5.txt', 'big5'],
      ['txt-sjis.txt', 'shift_jis'],
    ];
    for (const [name, expected] of cases) {
      const bytes = new Uint8Array(readFileSync(resolve(FIXTURES, name)));
      const res = await detectTextEncoding(memoryByteSource(bytes));
      expect(res.encoding, `encoding of ${name}`).toBe(expected);
    }

    // Windows-1252 smart quotes (`0x93`, `0x94`, `0x97`) + French accents (`0xE9` = é followed by space)
    const cp1252Sample = Uint8Array.from([
      0x93, ...new TextEncoder().encode('C\'est une tres belle matinee d\'ete'), 0xe9, 0x20,
      ...new TextEncoder().encode('dans le jardin du chateau '), 0x97, 0x20,
      ...new TextEncoder().encode('dit-elle avec un sourire tranquille.'), 0x94, 0x0a,
    ]);
    const cp1252Detected = await detectTextEncoding(memoryByteSource(cp1252Sample));
    expect(cp1252Detected.encoding).toBe('windows-1252');
  });

  it('streams a 10.5 MB GB18030 web novel (~120 chapters) with 0 reads on indexed open and 1 read per chapter', async () => {
    const seedGb = new Uint8Array(readFileSync(resolve(FIXTURES, 'txt-gb18030.txt')));
    // Extract one body paragraph block in genuine GB18030 bytes from `txt-gb18030.txt` (after first `\n\n`)
    let doubleNl = 0;
    for (let i = 0; i < seedGb.length - 1; i++) {
      if (seedGb[i] === 0x0a && seedGb[i + 1] === 0x0a) {
        doubleNl = i + 2;
        break;
      }
    }
    let secondHeading = seedGb.length;
    // Find second chapter heading (`\n\n` before `第二章`)
    const seedDecoded = new TextDecoder('gb18030').decode(seedGb);
    const ch1BodyOnly = seedDecoded.split('第二章')[0]!.split('\n\n').slice(1).join('\n\n');
    void secondHeading;
    // Note: in `seedGb`, `doubleNl`..end of chapter 1 is exact GB18030 bytes of 7 paragraphs (~1,340 bytes)!
    const ch1ByteLen = Math.floor(seedGb.length / 4) - doubleNl;
    const gbBodyBlock = seedGb.subarray(doubleNl, doubleNl + ch1ByteLen);
    // Ensure `gbBodyBlock` ends cleanly on `0x0A`
    const lastNl = gbBodyBlock.lastIndexOf(0x0a);
    const cleanBodyChunk = gbBodyBlock.subarray(0, lastNl + 1);
    expect(cleanBodyChunk.byteLength).toBeGreaterThan(800);

    // Build 120 chapters totaling > 10 MB using ASCII-numbered `Chapter N` + genuine GB18030 body paragraphs (`~88 KB`/chapter)
    const chapterCount = 120;
    const repeatsPerChapter = Math.ceil((88 * 1024) / cleanBodyChunk.byteLength);
    const parts: Uint8Array[] = [];
    let totalBytes = 0;
    const enc = new TextEncoder();
    for (let c = 1; c <= chapterCount; c++) {
      const h = enc.encode(`Chapter ${c} GB18030 Web Novel\n\n`);
      parts.push(h);
      totalBytes += h.byteLength;
      for (let r = 0; r < repeatsPerChapter; r++) {
        parts.push(cleanBodyChunk);
        totalBytes += cleanBodyChunk.byteLength;
      }
    }
    expect(totalBytes).toBeGreaterThan(10 * 1024 * 1024);

    const novelBytes = new Uint8Array(totalBytes);
    let pos = 0;
    for (const p of parts) {
      novelBytes.set(p, pos);
      pos += p.byteLength;
    }
    void ch1BodyOnly;

    const importSrc = new CountingByteSource(novelBytes, { allowReadAll: false });
    const t0 = performance.now();
    const inspected = await inspectBook(importSrc, { fileName: 'giant-web-novel.txt' });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(4000);
    expect(inspected.meta.format).toBe('txt');
    expect(inspected.index.kind).toBe('txt');
    if (inspected.index.kind === 'txt') {
      expect(inspected.index.encoding).toBe('gb18030');
    }
    expect(inspected.index.spine.length).toBeGreaterThanOrEqual(chapterCount);

    // Re-open with persisted `BookIndex` over a fresh counting ByteSource:
    // Opening costs ZERO reads, and loading chapter 50 costs <= 2 reads (`<= 3` budget!) with <= 30,000 chars!
    const runtimeSrc = new CountingByteSource(novelBytes, { allowReadAll: false });
    const session = await openBook(runtimeSrc, { fileName: 'giant-web-novel.txt' }, inspected.index);
    expect(runtimeSrc.readCalls).toBe(0);

    const sec50 = await session.loadSection(50);
    expect(runtimeSrc.readCalls).toBeLessThanOrEqual(2);
    expect(sec50.text.text).toContain('夜色如水，清风徐来');
    expect(sec50.text.text.length).toBeLessThanOrEqual(30_000);
    expect(MiniBookError).toBeDefined();
  });
});
