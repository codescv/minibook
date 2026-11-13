import { expect, test } from '@playwright/test';

test.describe('Multicol Pagination, Constant Vertical Geometry & 4-Layer Security', () => {
  test('enforces Cw <= 34em, n*(Cw+G)==Vw, and text rects inside [G/2-1, Vw-G/2+1] across mobile, desktop 1-col & 2-col spread', async ({
    page,
  }) => {
    const configs = [
      { width: 393, height: 852, expectedCols: 1 },
      { width: 1050, height: 820, expectedCols: 1 },
      { width: 1440, height: 900, expectedCols: 2 },
    ];

    for (const cfg of configs) {
      await page.setViewportSize({ width: cfg.width, height: cfg.height });
      await page.goto('/?book=b_dickens&theme=original');
      await page.waitForSelector('iframe.mb-reader-frame');

      // Wait for frame body content to settle
      await expect
        .poll(async () => {
          return page.evaluate(() => {
            const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
            return iframe?.contentDocument?.body?.textContent?.includes('best of times') ?? false;
          });
        })
        .toBe(true);

      const metrics = await page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[style*="visibility: visible"]',
        )!;
        const fDoc = iframe.contentDocument!;
        const htmlCs = iframe.contentWindow!.getComputedStyle(fDoc.documentElement);
        const bodyCs = iframe.contentWindow!.getComputedStyle(fDoc.body);

        const Vw = Math.round(parseFloat(htmlCs.width));
        const fontSize = parseFloat(htmlCs.fontSize);
        const Cw = Math.round(parseFloat(bodyCs.columnWidth));
        const G = Math.round(parseFloat(bodyCs.columnGap));
        const padLeft = Math.round(parseFloat(bodyCs.paddingLeft));

        // Walk visible text nodes on Screen 0 and ensure no rect bleeds outside [G/2 - 1, Vw - G/2 + 1]
        const outOfBounds: string[] = [];
        const walker = fDoc.createTreeWalker(fDoc.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const text = node.nodeValue ?? '';
          if (text.trim().length > 0) {
            const r = fDoc.createRange();
            r.selectNodeContents(node);
            for (const rect of Array.from(r.getClientRects())) {
              if (rect.width < 0.5) continue;
              // Only inspect rects visible within the current [0, Vw] screen
              if (rect.right > 0 && rect.left < Vw) {
                if (rect.left < G / 2 - 1.5 || rect.right > Vw - G / 2 + 1.5) {
                  outOfBounds.push(
                    `left=${rect.left.toFixed(1)} right=${rect.right.toFixed(1)} allowed=[${G / 2 - 1}, ${Vw - G / 2 + 1}]`,
                  );
                }
              }
            }
          }
          node = walker.nextNode();
        }

        return { Vw, fontSize, Cw, G, padLeft, outOfBounds };
      });

      const n = cfg.expectedCols;
      expect(metrics.Cw).toBeLessThanOrEqual(Math.round(34 * metrics.fontSize));
      expect(metrics.G % 2).toBe(0);
      expect(metrics.padLeft).toBe(metrics.G / 2);
      expect(n * (metrics.Cw + metrics.G)).toBe(metrics.Vw);
      if (n === 2) {
        expect(metrics.G).toBeGreaterThanOrEqual(64);
      }
      expect(metrics.outOfBounds).toEqual([]);
    }
  });

  test('causes ZERO reflow and ZERO line-break shift when toggling Chrome or ReadAloudBar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/?book=b_dickens&theme=paper');
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return iframe?.contentDocument?.body?.textContent?.includes('best of times') ?? false;
        }),
      )
      .toBe(true);

    const snapshotLineRects = async () =>
      page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[style*="visibility: visible"]',
        )!;
        const fDoc = iframe.contentDocument!;
        const sentinel = fDoc.getElementById('mb-end')!.getBoundingClientRect();
        const firstPara = fDoc.querySelector('p')!;
        const range = fDoc.createRange();
        range.selectNodeContents(firstPara);
        const lines = Array.from(range.getClientRects()).map((r) => ({
          l: Math.round(r.left * 10) / 10,
          t: Math.round(r.top * 10) / 10,
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
        }));
        return {
          bodyHeight: fDoc.body.getBoundingClientRect().height,
          sentinelLeft: Math.round(sentinel.left),
          lines,
        };
      });

    // 1. Bare page snapshot
    const bare = await snapshotLineRects();
    expect(bare.lines.length).toBeGreaterThan(3);

    // 2. Tap center zone inside iframe to summon 1-tap Chrome
    const frameBox = await page.locator('iframe.mb-reader-frame').first().boundingBox();
    expect(frameBox).not.toBeNull();
    await page.mouse.click(frameBox!.x + frameBox!.width * 0.5, frameBox!.y + frameBox!.height * 0.5);

    await expect(page.getByRole('button', { name: 'Back to Library' })).toBeVisible();
    // Normal mode Chrome has exact 5 top controls
    const topControls = await page.locator('.mb-chrome-top button').count();
    expect(topControls).toBe(5);

    const withChrome = await snapshotLineRects();
    expect(withChrome).toEqual(bare);

    // 3. Start Read Aloud -> summons ReadAloudBar + sentence highlight
    await page.getByRole('button', { name: 'Read aloud' }).click();
    await expect(page.getByRole('navigation', { name: 'Read aloud' })).toBeVisible();

    const withReadAloud = await snapshotLineRects();
    expect(withReadAloud).toEqual(bare);
  });

  test('renders 42,000-char chapter via virtual render units and preserves anchor on font change', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/?book=b_long40k&theme=original');
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return iframe?.contentDocument?.body?.textContent?.includes('Paragraph 1.') ?? false;
        }),
      )
      .toBe(true);

    // Turn 2 pages forward using keyboard ArrowRight
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(220);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(220);

    const scrollBefore = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[style*="visibility: visible"]',
      )!;
      return iframe.contentDocument!.documentElement.scrollLeft;
    });
    expect(scrollBefore).toBeGreaterThan(0);

    // Open Appearance ('a') and bump font size twice -> verify page re-anchors without jumping back to 0
    await page.keyboard.press('a');
    await expect(page.getByRole('dialog', { name: 'Appearance' })).toBeVisible();
    await page.getByRole('button', { name: 'Increase text size' }).click();
    await page.getByRole('button', { name: 'Increase text size' }).click();

    const scrollAfter = await page.evaluate(() => {
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[style*="visibility: visible"]',
      )!;
      return iframe.contentDocument!.documentElement.scrollLeft;
    });
    expect(scrollAfter).toBeGreaterThan(0);
  });

  test('blocks XSS script execution and remote tracking requests inside SectionFrame (4-layer CSP)', async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('evil.example.invalid')) {
        externalRequests.push(req.url());
      }
    });

    await page.goto('/?book=b_xss&theme=original');
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return iframe?.contentDocument?.body?.textContent?.includes('Clean readable prose') ?? false;
        }),
      )
      .toBe(true);

    const securityAudit = await page.evaluate(() => {
      const win = window as Window & { __xssExecuted?: boolean };
      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[style*="visibility: visible"]',
      )!;
      const fDoc = iframe.contentDocument!;
      const cspMeta = fDoc.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const scriptTags = fDoc.querySelectorAll('script').length;
      return {
        xssExecuted: Boolean(win.__xssExecuted),
        cspContent: cspMeta?.getAttribute('content') ?? '',
        scriptTags,
      };
    });

    expect(securityAudit.xssExecuted).toBe(false);
    expect(securityAudit.scriptTags).toBe(0);
    expect(securityAudit.cspContent).toContain("default-src 'none'");
    expect(securityAudit.cspContent).toContain("script-src 'none'");
    expect(securityAudit.cspContent).toContain("connect-src 'none'");
    expect(externalRequests).toEqual([]);
  });

  test('verifies locator -> page -> locator round-trips, locatorAtPoint/locatorFromRange, and whitespace pageOf resilience', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/?book=b_long40k&theme=original');
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return iframe?.contentDocument?.body?.textContent?.includes('Paragraph 1.') ?? false;
        }),
      )
      .toBe(true);

    const roundTrip = await page.evaluate(async () => {
      const harness = (window as unknown as { __minibookTestHarness: {
        host: { openMockSession: (id: string) => Promise<{ loadSection: (i: number) => Promise<unknown> }> };
        TextMap: new (root: Element, expected?: string) => { length: number; text: string; rangeFor: (s: number, e: number) => Range | null };
        Paginator: new (opts: Record<string, unknown>) => {
          getPageCount: () => number;
          goToPage: (p: number) => number;
          pageOf: (off: number) => number;
          firstVisibleLocator: (p: number) => { section: number; offset: number };
          locatorAtPoint: (x: number, y: number) => { section: number; offset: number } | null;
          locatorFromRange: (r: Range) => { section: number; offset: number } | null;
        };
        computePaginationGeometry: (inp: Record<string, unknown>) => Record<string, unknown>;
      } }).__minibookTestHarness;

      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[style*="visibility: visible"]',
      )!;
      const fDoc = iframe.contentDocument!;
      const sess = await harness.host.openMockSession('b_long40k');
      const secDoc = (await sess.loadSection(0)) as { unit: { start: number; end: number }; text: { text: string } };
      const tm = new harness.TextMap(fDoc.body, secDoc.text.text);
      const geom = harness.computePaginationGeometry({
        frameWidth: 393,
        frameHeight: 852,
        fontScale: 100,
        margins: 'medium',
        safeTop: 59,
        safeBottom: 34,
        isEink: false,
      });
      const pag = new harness.Paginator({
        frameDoc: fDoc,
        textMap: tm,
        sectionDoc: secDoc,
        geometry: geom,
      });

      const totalPages = pag.getPageCount();
      // 1. Round-trip across pages 0..5: firstVisibleLocator(p) -> pageOf(loc.offset) === p
      const pageMismatches: string[] = [];
      for (let p = 0; p < Math.min(6, totalPages); p++) {
        const loc = pag.firstVisibleLocator(p);
        const mappedPage = pag.pageOf(loc.offset);
        if (mappedPage !== p) {
          pageMismatches.push(`page ${p} -> offset ${loc.offset} -> page ${mappedPage}`);
        }
      }

      // 2. Whitespace offsets never throw and always return valid [0, totalPages - 1]
      for (let i = 0; i < Math.min(800, tm.text.length); i++) {
        if (/\s/.test(tm.text[i]!)) {
          const wp = pag.pageOf(i);
          if (wp < 0 || wp >= totalPages || Number.isNaN(wp)) {
            pageMismatches.push(`whitespace at ${i} gave invalid page ${wp}`);
          }
        }
      }

      // 3. locatorFromRange inverse round-trip
      pag.goToPage(0);
      const sampleRange = tm.rangeFor(120, 145)!;
      const fromRange = pag.locatorFromRange(sampleRange);

      // 4. locatorAtPoint inverse lookup on visible text rect
      const sampleRect = sampleRange.getClientRects()[0]!;
      const fromPoint = pag.locatorAtPoint(sampleRect.left + 4, sampleRect.top + sampleRect.height / 2);

      return {
        totalPages,
        pageMismatches,
        fromRangeOffset: fromRange?.offset ?? -1,
        fromPointValid: fromPoint !== null && Math.abs(fromPoint.offset - 120) < 40,
      };
    });

    expect(roundTrip.totalPages).toBeGreaterThan(10);
    expect(roundTrip.pageMismatches).toEqual([]);
    expect(roundTrip.fromRangeOffset).toBe(120);
    expect(roundTrip.fromPointValid).toBe(true);
  });
});
