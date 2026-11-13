/**
 * End-to-end cross-package integration tests (`@minibook/core` + `@minibook/host-node`):
 *   - Imports every supported ebook format (`.epub`, `.azw3`/KF8, `.mobi` 6/combo/HUFF-CDIC,
 *     `.fb2`, `.fb2.zip`, `.txt` GB18030 & UTF-16LE, `.md`) via both CLI `importLocalFile`
 *     and browser `RestPlatformHost` (`beginImport -> inspectBook -> commitImport`).
 *   - Opens sessions over HTTP `206 Partial Content` `Range` (`book` + derived `text.bin`),
 *     loads sections, verifies `u.text === sectionText.text.slice(u.start, u.end)` segmentation,
 *     and verifies adversarial DRM / zip-bomb fixtures are cleanly rejected without leaking staged files.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MiniBookError,
  WindowedByteSource,
  inspectBook,
  memoryByteSource,
  openBook,
  search,
  segmentSection,
} from '@minibook/core';
import { createRestPlatformHost } from '../client/rest-host.js';
import { startServer, type RunningServer } from './start.js';

const FIXTURES_DIR = resolve(fileURLToPath(new URL('../../../../fixtures', import.meta.url)));

describe('End-to-End Fixture Integration (@minibook/core + @minibook/host-node)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  async function bootServer(): Promise<{ running: RunningServer; dataDir: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'minibook-e2e-int-'));
    const running = await startServer({ dataDir, port: 0 });
    cleanups.push(async () => {
      await running.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { running, dataDir };
  }

  it('imports all real fixture formats via CLI importLocalFile and reads sections over HTTP 206 Range', async () => {
    const { running } = await bootServer();

    const fixtureNames = [
      'epub3-modern.epub',
      'epub2-classic.epub',
      'kf8-sample.azw3',
      'mobi6-classic.mobi',
      'mobi-combo.mobi',
      'mobi-huffcdic.mobi',
      'sample-utf8.fb2',
      'sample.fb2.zip',
      'txt-gb18030.txt',
      'txt-utf16le.txt',
      'sample.md',
    ] as const;

    const restHost = createRestPlatformHost({
      baseUrl: running.url,
      enableSse: false,
    });

    for (const fileName of fixtureNames) {
      const imported = await running.context.importLocalFile(join(FIXTURES_DIR, fileName));
      expect(imported.title.length).toBeGreaterThan(0);

      const detail = await restHost.library.get(imported.id);
      expect(detail).not.toBeNull();

      const rawBytes = new WindowedByteSource(restHost.files.byteSource(imported.id, 'book'));
      const session = await openBook(
        rawBytes,
        {
          fileName: detail!.fileName,
          getDerived: (name) => {
            if (name !== 'text.bin') return null;
            const derived = restHost.files.byteSource(imported.id, 'text');
            return derived.size > 0 ? new WindowedByteSource(derived) : null;
          },
        },
        detail!.index,
      );

      expect(session.spine.length).toBeGreaterThan(0);
      const firstLinear = session.spine.find((s) => s.linear)?.index ?? 0;
      const doc = await session.loadSection(firstLinear, 0);
      expect(doc.xhtml.length).toBeGreaterThan(0);

      if (doc.text.text.trim().length > 0) {
        const utterances = segmentSection(firstLinear, doc.text, {
          bookLang: session.meta.language,
        });
        expect(utterances.length).toBeGreaterThan(0);
        for (const u of utterances) {
          expect(u.text).toBe(doc.text.text.slice(u.start, u.end));
        }
      }

      session.close();
    }

    const shelf = await restHost.library.list();
    expect(shelf.length).toBe(fixtureNames.length);
  });

  it('imports KF8 (.azw3) and EPUB via browser RestPlatformHost upload + derived text.bin and runs full-book search', async () => {
    const { running, dataDir } = await bootServer();
    const restHost = createRestPlatformHost({
      baseUrl: running.url,
      enableSse: false,
    });

    for (const fileName of ['kf8-sample.azw3', 'epub3-modern.epub'] as const) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, fileName)));
      const src = {
        name: fileName,
        size: bytes.byteLength,
        bytes: memoryByteSource(bytes),
      };
      const ticket = await restHost.library.beginImport(src);
      const inspected = await inspectBook(src.bytes, {
        fileName,
        putDerived: (name, chunk) => ticket.putDerived(name, chunk),
      });
      const committed = await restHost.library.commitImport(ticket, inspected);
      const detail = await restHost.library.get(committed.id);
      expect(detail).not.toBeNull();

      const session = await openBook(
        new WindowedByteSource(restHost.files.byteSource(committed.id, 'book')),
        {
          fileName: detail!.fileName,
          getDerived: (name) => {
            if (name !== 'text.bin') return null;
            const d = restHost.files.byteSource(committed.id, 'text');
            return d.size > 0 ? new WindowedByteSource(d) : null;
          },
        },
        detail!.index,
      );

      const firstLinear = session.spine.find((s) => s.linear)?.index ?? 0;
      const sec = await session.loadSection(firstLinear, 0);
      const trimmed = sec.text.text.trim();
      const queryStr = trimmed.slice(0, Math.min(8, trimmed.length)).trim();

      if (queryStr.length >= 2) {
        const hits = [];
        for await (const h of search(session, queryStr)) {
          hits.push(h);
          if (hits.length >= 3) break;
        }
        expect(hits.length).toBeGreaterThan(0);
      }

      session.close();
    }

    // Rejects DRM and unsupported formats cleanly at import and leaves zero orphan files in tmp/
    for (const [advName, raw, expectedCode] of [
      [
        'adversarial-drm-epub.epub',
        new Uint8Array(readFileSync(join(FIXTURES_DIR, 'adversarial-drm-epub.epub'))),
        'drm-protected',
      ],
      [
        'adversarial-drm-mobi.azw3',
        new Uint8Array(readFileSync(join(FIXTURES_DIR, 'adversarial-drm-mobi.azw3'))),
        'drm-protected',
      ],
      ['manual.pdf', new TextEncoder().encode('%PDF-1.7\n'), 'unsupported-format'],
    ] as const) {
      const src = { name: advName, size: raw.byteLength, bytes: memoryByteSource(raw) };
      const ticket = await restHost.library.beginImport(src);
      let caught: unknown = null;
      try {
        await inspectBook(src.bytes, {
          fileName: advName,
          putDerived: (n, c) => ticket.putDerived(n, c),
        });
      } catch (err) {
        caught = err;
        await ticket.abort();
      }
      expect(caught).toBeInstanceOf(MiniBookError);
      expect((caught as MiniBookError).code).toBe(expectedCode);
    }

    // Zip-bomb chapter entry is blocked with `too-large` on lazy section inflation
    const zipBombBytes = new Uint8Array(
      readFileSync(join(FIXTURES_DIR, 'adversarial-zipbomb.epub')),
    );
    const zbSession = await openBook(memoryByteSource(zipBombBytes), {
      fileName: 'adversarial-zipbomb.epub',
    });
    await expect(zbSession.loadSection(0)).rejects.toMatchObject({ code: 'too-large' });
    zbSession.close();

    const tmpRemaining = readdirSync(join(dataDir, 'tmp'));
    expect(tmpRemaining).toEqual([]);
  });
});
