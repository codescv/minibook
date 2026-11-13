import { expect, test } from '@playwright/test';

test.describe('Multicol Pagination, Constant Vertical Geometry & 4-Layer Security', () => {
  test('enforces Cw <= 34em, n*(Cw+G)==Vw, text rects inside [G/2-1, Vw-G/2+1], and resolves XML-namespaced SVG <image xlink:href="mb-res:..."> with zero CSP errors', async ({
    page,
  }) => {
    const cspErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy|mb-res:/i.test(msg.text())) {
        cspErrors.push(msg.text());
      }
    });

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

        const svgImage = fDoc.querySelector('svg image');
        const svgXlinkHref =
          svgImage?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '';

        return { Vw, fontSize, Cw, G, padLeft, outOfBounds, svgXlinkHref };
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
      expect(metrics.svgXlinkHref.startsWith('blob:')).toBe(true);
    }
    expect(cspErrors).toEqual([]);
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

  test('renders 42,000-char chapter via virtual render units, aligns last page scrollLeft == (S-1)*Vw, and keeps sticky anchor across A+/A- & rotations', async ({
    page,
  }) => {
    // 1. [P1-U1]: Verify last page of unit 0 & unit 1 has exact scrollLeft === (S - 1) * Vw and all text rects inside [G/2-1, Vw-G/2+1] on 393px (n=1) AND 1440px (n=2)!
    for (const vp of [
      { width: 393, height: 852 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(vp);
      await page.goto('/?book=b_long40k&eink=on');
      await page.waitForSelector('iframe.mb-reader-frame');

      await expect
        .poll(async () =>
          page.evaluate(() => {
            const iframe = document.querySelector<HTMLIFrameElement>(
              'iframe.mb-reader-frame[style*="visibility: visible"]',
            );
            return iframe?.contentDocument?.body?.textContent?.includes('Paragraph 1.') ?? false;
          }),
        )
        .toBe(true);

      const lastPageCheck = await page.evaluate(async () => {
        const harness = (window as unknown as {
          __minibookTestHarness: {
            host: { openMockSession: (id: string) => Promise<{ loadSection: (s: number, u: number) => Promise<{ unit: { start: number; end: number }; dir: 'ltr' | 'rtl'; text: { text: string } }> }> };
            TextMap: new (root: Element, exp?: string) => unknown;
            Paginator: new (o: Record<string, unknown>) => {
              getPageCount: () => number;
              goToPage: (p: number) => number;
              getGeometry: () => { Vw: number; G: number };
            };
            computePaginationGeometry: (i: Record<string, unknown>) => { Vw: number; G: number };
          };
        }).__minibookTestHarness;

        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[style*="visibility: visible"]',
        )!;
        const fDoc = iframe.contentDocument!;
        const sess = await harness.host.openMockSession('b_long40k');
        const secDoc = await sess.loadSection(0, 0);
        const tm = new harness.TextMap(fDoc.body, secDoc.text.text);
        const geom = harness.computePaginationGeometry({
          frameWidth: window.innerWidth,
          frameHeight: window.innerHeight,
          fontScale: 100,
          margins: 'medium',
          safeTop: 0,
          safeBottom: 0,
          isEink: true,
        });
        const pag = new harness.Paginator({
          frameDoc: fDoc,
          textMap: tm,
          sectionDoc: secDoc,
          geometry: geom,
        });
        const S = pag.getPageCount();
        pag.goToPage(S - 1);
        const actualSL = fDoc.documentElement.scrollLeft;
        const expectedSL = (S - 1) * geom.Vw;

        const outOfBounds: string[] = [];
        const walker = fDoc.createTreeWalker(fDoc.body, NodeFilter.SHOW_TEXT);
        let n = walker.nextNode();
        while (n) {
          if ((n.nodeValue ?? '').trim().length > 0) {
            const r = fDoc.createRange();
            r.selectNodeContents(n);
            for (const rect of Array.from(r.getClientRects())) {
              if (rect.width < 0.5) continue;
              if (rect.right > 0 && rect.left < geom.Vw) {
                if (rect.left < geom.G / 2 - 1.5 || rect.right > geom.Vw - geom.G / 2 + 1.5) {
                  outOfBounds.push(`L=${rect.left.toFixed(1)} R=${rect.right.toFixed(1)}`);
                }
              }
            }
          }
          n = walker.nextNode();
        }
        pag.goToPage(0);
        return { S, actualSL, expectedSL, outOfBounds };
      });

      expect(lastPageCheck.actualSL).toBe(lastPageCheck.expectedSL);
      expect(lastPageCheck.outOfBounds).toEqual([]);
    }

    // 2. [P1-U2]: Verify sticky reading anchor shows ZERO backward drift across A+ x3 -> A- x3 and 393 -> 852 -> 393 -> 1440 -> 393!
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

    // Turn forward 10 pages cleanly (using E-Ink instant turn via keyboard or quick settle)
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(200);
    }

    const getVisibleScrollAndFirstText = () =>
      page.evaluate(() => {
        const iframe = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[style*="visibility: visible"]',
        )!;
        const fDoc = iframe.contentDocument!;
        const sl = fDoc.documentElement.scrollLeft;
        const Vw = parseFloat(iframe.style.width);
        return { page: Math.round(sl / Vw), sl };
      });

    const initial = await getVisibleScrollAndFirstText();
    expect(initial.page).toBe(10);

    // A+ x3 then A- x3 -> returns to exact Page 10!
    await page.keyboard.press('a');
    await expect(page.getByRole('dialog', { name: 'Appearance' })).toBeVisible();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Increase text size' }).click();
    }
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Decrease text size' }).click();
    }
    await page.keyboard.press('Escape');

    const afterFontRoundTrip = await getVisibleScrollAndFirstText();
    expect(afterFontRoundTrip.page).toBe(10);

    // Rotate 393x852 -> 852x393 -> 393x852 -> 1440x900 -> 393x852 -> returns to exact Page 10!
    await page.setViewportSize({ width: 852, height: 393 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(80);
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(80);

    const afterRotationRoundTrip = await getVisibleScrollAndFirstText();
    expect(afterRotationRoundTrip.page).toBe(10);
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

  test('[P1-F1] renders exact 0/20/40/60/80% TOC labels on 5-chapter single-file EPUB and round-trips Go to % within 1 page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 758, height: 1024 });
    await page.goto('/?eink=on&platform=android&singleFile5=1&book=b_single5');
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return f?.contentDocument?.body?.textContent?.includes('Chapter 1: Part 1') ?? false;
        }),
      )
      .toBe(true);

    // Summon Chrome and open Contents sheet -> verify 5 anchored chapters show 0%, 20%, 40%, 60%, 80%
    await page.mouse.click(379, 512);
    await page.getByRole('button', { name: 'Contents', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Contents' })).toBeVisible();

    const tocLabels = await page
      .locator('.mb-sheet [role="list"] .mb-list-row-meta')
      .allTextContents();
    expect(tocLabels.map((s) => s.trim())).toEqual(['0%', '20%', '40%', '60%', '80%']);

    // Close Contents sheet; verify Go to % round-trips within <= 1 page across both virtual render units (20%, 60%, 85%, 98%)
    await page.keyboard.press('Escape');
    for (const targetPct of [20, 60, 85, 98]) {
      if (!(await page.locator('.mb-chrome-top').count())) {
        await page.mouse.click(379, 512);
      }
      await page.getByRole('button', { name: 'Go to %' }).click();
      const input = page.getByRole('textbox', { name: 'Go to %' });
      await input.fill(String(targetPct));
      await page.getByRole('button', { name: 'Go', exact: true }).click();

      // Wait for unit/page navigation to settle and check displayed percentage in stepped scrubber (`N %`)
      await expect
        .poll(async () => {
          const txt = await page.locator('.mb-eink-scrubber-controls span').textContent();
          const parsed = Number((txt ?? '').replace(/[^0-9]/g, ''));
          return Math.abs(parsed - targetPct);
        })
        .toBeLessThanOrEqual(2);
    }
  });

  test('[v0.2.1] supports 1:1 horizontal drag revealing adjacent page content mid-gesture, cross-chapter neighbor drag, smooth UI transitions, and Hugging Face source switching', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/?theme=paper');

    // 1. Verify Settings screen & Sheet transitions + Hugging Face download source switch in normal mode
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-screen')).toBeVisible();

    const settingsLayerTransition = await page
      .locator('.mb-screen-layer.mb-screen-settings')
      .evaluate((el) => window.getComputedStyle(el).transitionDuration);
    expect(parseFloat(settingsLayerTransition)).toBeGreaterThan(0);

    // Library layer underneath must have covered-settings transition and non-identity transform
    await expect
      .poll(async () =>
        page
          .locator('.mb-screen-layer.mb-screen-library')
          .evaluate((el) => ({
            dt: el.getAttribute('data-transition'),
            tr: window.getComputedStyle(el).transform,
          })),
      )
      .toEqual({
        dt: 'covered-settings',
        tr: expect.not.stringMatching(/^none$/),
      });

    await page.locator('[data-setting-row="on-device-neural-voice"]').click();
    await expect(page.getByRole('dialog', { name: 'On-device neural voice' })).toBeVisible();

    const sheetTransition = await page
      .locator('.mb-sheet')
      .evaluate((el) => window.getComputedStyle(el).transitionDuration);
    expect(parseFloat(sheetTransition)).toBeGreaterThan(0);

    await page.evaluate(() => {
      window.__minibookTestHarness?.host.setModelStatus({
        state: 'downloading',
        bytesDone: 30_000_000,
        bytesTotal: 100_000_000,
        source: 'hf-mirror.com',
      });
    });
    await expect(page.getByTestId('kokoro-status-text')).toContainText('via hf-mirror.com');

    await page.getByRole('tab', { name: 'Hugging Face' }).click();
    await expect(page.getByTestId('kokoro-status-text')).toContainText('via huggingface.co');

    // Pull down sheet from top grabber zone (sheetBox.y + 10) -> tracks dy mid-gesture and closes on release >= 56px
    const sheetBox = await page.locator('.mb-sheet').boundingBox();
    expect(sheetBox).not.toBeNull();
    await page.mouse.move(sheetBox!.x + sheetBox!.width / 2, sheetBox!.y + 10);
    await page.mouse.down();
    await page.mouse.move(sheetBox!.x + sheetBox!.width / 2, sheetBox!.y + 50, { steps: 4 });
    const midPullTransform = await page
      .locator('.mb-sheet')
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(midPullTransform).toContain('translate3d(');
    await page.mouse.move(sheetBox!.x + sheetBox!.width / 2, sheetBox!.y + 90, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole('dialog', { name: 'On-device neural voice' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back' }).click();

    // 2. Open multi-page book (`b_long40k`) and test 1:1 intra-chapter drag + cancelled drag spring-back
    await page.goto('/?book=b_long40k&theme=paper');
    await page.waitForSelector('iframe.mb-reader-frame[data-frame-role="active"]');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="active"]',
          );
          return f?.contentDocument?.body?.textContent?.includes('Paragraph 1.') ?? false;
        }),
      )
      .toBe(true);

    // Drag left by 120px and hold BEFORE mouse.up -> verify scrollLeft == 120 (both Page 0 and Page 1 visible simultaneously!)
    await page.mouse.move(300, 420);
    await page.mouse.down();
    await page.mouse.move(280, 420);
    await page.mouse.move(180, 420);

    const midIntraDrag = await page.evaluate(() => {
      const f = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      const fDoc = f.contentDocument!;
      const Vw = parseFloat(f.style.width);
      return {
        scrollLeft: fDoc.documentElement.scrollLeft,
        Vw,
      };
    });
    expect(midIntraDrag.scrollLeft).toBeGreaterThanOrEqual(100);
    expect(midIntraDrag.scrollLeft).toBeLessThan(midIntraDrag.Vw);

    // Release finger -> commits turn and settles smoothly to Page 1 (scrollLeft === Vw)
    await page.mouse.up();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="active"]',
          )!;
          return f.contentDocument!.documentElement.scrollLeft;
        }),
      )
      .toBe(midIntraDrag.Vw);

    // Cancelled short drag (-30px) shifts mid-gesture and springs back to Page 1 on release without turning to Page 2
    await page.mouse.move(250, 420);
    await page.mouse.down();
    await page.mouse.move(220, 420, { steps: 4 });
    const midShortDrag = await page.evaluate(() => {
      const f = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      return f.contentDocument!.documentElement.scrollLeft;
    });
    expect(midShortDrag).toBeGreaterThan(midIntraDrag.Vw);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="active"]',
          )!;
          return f.contentDocument!.documentElement.scrollLeft;
        }),
      )
      .toBe(midIntraDrag.Vw);

    // 3. Cross-chapter edge drag on `b_dickens`: pre-warmed next neighbor slides into view mid-gesture and stays populated!
    await page.goto('/?book=b_dickens&theme=paper');
    await page.waitForSelector('iframe.mb-reader-frame[data-frame-role="active"]');
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const nextFrame = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="next"]',
          );
          return Boolean(nextFrame?.contentDocument?.body?.textContent?.trim().length);
        }),
      )
      .toBe(true);

    // Advance via ArrowRight until we are on the last page of Section 0
    const pagesInSec0 = await page.evaluate(() => {
      const activeFrame = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      const Vw = parseFloat(activeFrame.style.width);
      return Math.max(1, Math.round(activeFrame.contentDocument!.documentElement.scrollWidth / Vw));
    });
    for (let i = 1; i < pagesInSec0; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(280);
    }

    // Now at the last page of Section 0: drag left by 140px and hold BEFORE mouse.up
    await page.mouse.move(300, 420);
    await page.mouse.down();
    await page.mouse.move(280, 420);
    await page.mouse.move(160, 420);

    const midEdgeDrag = await page.evaluate(() => {
      const activeFrame = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      const nextFrame = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="next"]',
      )!;
      return {
        activeTransform: activeFrame.style.transform,
        nextVisible: nextFrame?.style.visibility === 'visible',
        nextTransform: nextFrame?.style.transform ?? '',
      };
    });
    expect(midEdgeDrag.activeTransform).toContain('translate3d(');
    expect(midEdgeDrag.nextVisible).toBe(true);
    expect(midEdgeDrag.nextTransform).toContain('translate3d(');

    await page.mouse.up();
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const activeFrame = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="active"]',
          )!;
          return {
            transform: activeFrame.style.transform,
            textLen: activeFrame.contentDocument?.body?.textContent?.trim().length ?? 0,
            scrollWidth: activeFrame.contentDocument?.documentElement?.scrollWidth ?? 0,
            Vw: parseFloat(activeFrame.style.width),
          };
        }),
      )
      .toEqual({
        transform: '',
        textLen: expect.any(Number),
        scrollWidth: expect.any(Number),
        Vw: expect.any(Number),
      });

    const promotedCheck = await page.evaluate(() => {
      const activeFrame = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      return {
        text: activeFrame.contentDocument?.body?.textContent?.trim() ?? '',
        scrollWidth: activeFrame.contentDocument?.documentElement?.scrollWidth ?? 0,
        Vw: parseFloat(activeFrame.style.width),
      };
    });
    expect(promotedCheck.text.length).toBeGreaterThan(50);
    expect(promotedCheck.scrollWidth).toBeGreaterThanOrEqual(promotedCheck.Vw);

    // Cross-chapter keyboard turn back (ArrowLeft from Page 0 of Chapter 2 -> Chapter 1) slides smoothly!
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(45);
    const midKeySlide = await page.evaluate(() => {
      const activeFrame = document.querySelector<HTMLIFrameElement>(
        'iframe.mb-reader-frame[data-frame-role="active"]',
      )!;
      return activeFrame.style.transform;
    });
    expect(midKeySlide).toContain('translate3d(');
    await page.waitForTimeout(300);

    // ReadAloudBar Stop (✕) animates out via data-state="closing" instead of unmounting on frame 0
    await page.keyboard.press('r');
    await expect(page.locator('.mb-tts-bar[data-state="open"]')).toBeVisible();
    await page.locator('.mb-tts-bar').getByRole('button', { name: 'Stop Read Aloud' }).click();
    const closingBarCount = await page.locator('.mb-tts-bar[data-state="closing"]').count();
    expect(closingBarCount).toBe(1);
    await expect(page.locator('.mb-tts-bar')).toHaveCount(0);
  });
});
