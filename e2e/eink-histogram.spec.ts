import { expect, test, type Page } from '@playwright/test';
import { decodePng } from './png-decoder';

async function assertEinkDomPurity(page: Page, contextName: string): Promise<void> {
  const violations = await page.evaluate(() => {
    const issues: string[] = [];
    const allowedColors = new Set([
      'rgba(0, 0, 0, 0)',
      'rgb(0, 0, 0)',
      'rgb(255, 255, 255)',
    ]);

    const checkDoc = (doc: Document, prefix: string): void => {
      for (const el of Array.from(doc.querySelectorAll('*'))) {
        const win = doc.defaultView!;
        const cs = win.getComputedStyle(el);
        if (cs.boxShadow !== 'none') issues.push(`${prefix}${el.tagName}: boxShadow=${cs.boxShadow}`);
        if (cs.textShadow !== 'none') issues.push(`${prefix}${el.tagName}: textShadow=${cs.textShadow}`);
        if (cs.filter !== 'none') issues.push(`${prefix}${el.tagName}: filter=${cs.filter}`);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') {
          issues.push(`${prefix}${el.tagName}: backdropFilter=${cs.backdropFilter}`);
        }
        if (cs.borderRadius !== '0px') {
          issues.push(`${prefix}${el.tagName}: borderRadius=${cs.borderRadius}`);
        }
        if (cs.transitionDuration !== '0s') {
          issues.push(`${prefix}${el.tagName}: transitionDuration=${cs.transitionDuration}`);
        }
        if (cs.animationDuration !== '0s') {
          issues.push(`${prefix}${el.tagName}: animationDuration=${cs.animationDuration}`);
        }
        if (cs.opacity !== '1') {
          issues.push(`${prefix}${el.tagName}: opacity=${cs.opacity}`);
        }
        for (const prop of [
          'backgroundColor',
          'color',
          'borderTopColor',
          'borderBottomColor',
          'borderLeftColor',
          'borderRightColor',
        ] as const) {
          const val = cs[prop];
          if (val && !allowedColors.has(val)) {
            issues.push(`${prefix}${el.tagName}: ${prop}=${val}`);
          }
        }
        // R3: zero scrollable containers in E-Ink mode
        if (
          (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight + 1
        ) {
          issues.push(`${prefix}${el.tagName}: scrollable (${el.scrollHeight} > ${el.clientHeight})`);
        }
      }
    };

    checkDoc(document, 'app:');
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe.mb-reader-frame[style*="visibility: visible"]',
    );
    if (iframe?.contentDocument) {
      checkDoc(iframe.contentDocument, 'frame:');
    }
    return issues;
  });

  expect(violations, `E-Ink DOM violations on ${contextName}`).toEqual([]);
}

/**
 * Verifies PRODUCT_DESIGN.md §8.6 #1 & ARCHITECTURE.md §9.2:
 * 1. Unmasked real screenshot has 0 chromatic pixels and 0 grey 4x4 area fills.
 * 2. With raster images, `<svg>` icons, and glyph stroke anti-aliasing masked (leaving all
 *    backgrounds, 1px/2px borders, dividers, sheets, steppers, toggles, inverted active buttons,
 *    and 2px TTS sentence underline bars intact), 100.000% of pixels are strictly
 *    `#000000` (`0,0,0`) or `#FFFFFF` (`255,255,255`).
 */
async function assertStrictTwoColorHistogram(
  page: Page,
  contextName: string,
  options?: { readonly expectStructuralBorders?: boolean },
): Promise<void> {
  // Pass A: Unmasked screenshot check (0 chromatic pixels outside book/cover images, 0 grey 4x4 fills)
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'mb-e2e-mask-img-only';
    s.textContent = `img { visibility: hidden !important; }`;
    document.head.appendChild(s);
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe.mb-reader-frame[style*="visibility: visible"]',
    );
    if (iframe?.contentDocument) {
      const fs = iframe.contentDocument.createElement('style');
      fs.id = 'mb-e2e-mask-img-only';
      fs.textContent = `img, svg { visibility: hidden !important; }`;
      iframe.contentDocument.head.appendChild(fs);
    }
  });

  const unmaskedBuf = await page.screenshot({ fullPage: false });
  const unmasked = decodePng(unmaskedBuf);

  let chromaticPixels = 0;
  for (let i = 0; i < unmasked.width * unmasked.height; i++) {
    const r = unmasked.rgba[i * 4]!;
    const g = unmasked.rgba[i * 4 + 1]!;
    const b = unmasked.rgba[i * 4 + 2]!;
    if (r !== g || g !== b) chromaticPixels++;
  }
  expect(chromaticPixels, `Chromatic pixels on ${contextName}`).toBe(0);

  // Check zero uniform 4x4 grey area fills on unmasked screenshot (catches any grey surface/scrim/track/pill while distinguishing CJK glyph stroke gradients)
  let greyAreaBlocks = 0;
  for (let y = 0; y <= unmasked.height - 4; y += 4) {
    for (let x = 0; x <= unmasked.width - 4; x += 4) {
      let allGrey = true;
      let minV = 255;
      let maxV = 0;
      for (let dy = 0; dy < 4 && allGrey; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const idx = ((y + dy) * unmasked.width + (x + dx)) * 4;
          const v = unmasked.rgba[idx]!;
          if (v === 0 || v === 255) {
            allGrey = false;
            break;
          }
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      if (allGrey && maxV - minV <= 4) greyAreaBlocks++;
    }
  }
  expect(greyAreaBlocks, `Uniform grey 4x4 area fills on ${contextName}`).toBe(0);

    // Pass B: Mask glyph AA & SVG diagonal stroke AA -> assert 100.000% strict #000000 / #FFFFFF histogram!
  await page.evaluate(() => {
    const maskCss = `
      img, svg { visibility: hidden !important; }
      *, *::before, *::after, *::placeholder {
        color: transparent !important;
        -webkit-text-fill-color: transparent !important;
        -webkit-text-stroke: 0px transparent !important;
        caret-color: transparent !important;
        text-decoration-color: transparent !important;
      }
    `;
    document.getElementById('mb-e2e-mask-img-only')!.textContent = maskCss;
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe.mb-reader-frame[style*="visibility: visible"]',
    );
    if (iframe?.contentDocument) {
      iframe.contentDocument.getElementById('mb-e2e-mask-img-only')!.textContent = maskCss;
    }
  });

  const maskedBuf = await page.screenshot({ fullPage: false });
  const masked = decodePng(maskedBuf);

  let nonBinaryPixels = 0;
  let blackPixels = 0;
  let whitePixels = 0;
  let firstOffender = '';

  for (let i = 0; i < masked.width * masked.height; i++) {
    const r = masked.rgba[i * 4]!;
    const g = masked.rgba[i * 4 + 1]!;
    const b = masked.rgba[i * 4 + 2]!;
    const a = masked.rgba[i * 4 + 3]!;
    if (a === 255 && r === 0 && g === 0 && b === 0) {
      blackPixels++;
    } else if (a === 255 && r === 255 && g === 255 && b === 255) {
      whitePixels++;
    } else {
      nonBinaryPixels++;
      if (!firstOffender) {
        const px = i % masked.width;
        const py = Math.floor(i / masked.width);
        firstOffender = `(${px},${py})=rgba(${r},${g},${b},${a})`;
      }
    }
  }

  // Remove temporary mask style so interactive crawl continues seamlessly
  await page.evaluate(() => {
    document.getElementById('mb-e2e-mask-img-only')?.remove();
    const iframe = document.querySelector<HTMLIFrameElement>(
      'iframe.mb-reader-frame[style*="visibility: visible"]',
    );
    iframe?.contentDocument?.getElementById('mb-e2e-mask-img-only')?.remove();
  });

  if (options?.expectStructuralBorders !== false) {
    expect(blackPixels, `Expected structural black borders/fills on ${contextName}`).toBeGreaterThan(100);
  }
  expect(whitePixels, `Expected white surfaces on ${contextName}`).toBeGreaterThan(1000);
  expect(
    nonBinaryPixels,
    `Strict 2-colour #000000/#FFFFFF histogram failed on ${contextName}: ${firstOffender}`,
  ).toBe(0);
}

test.describe('Android E-Ink Mode (`墨水屏模式`) Full-App Crawl & 2-Colour Histogram', () => {
  test('verifies strict #000000/#FFFFFF 2-colour histogram, PagedList, 6-icon chrome, TTS underline & Settings', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 758, height: 1024 });
    await page.goto('/?eink=on&platform=android&extraBooks=10');

    // Dismiss one-time auto notice if shown, verify PagedList Library
    await expect(page.getByTestId('paged-list-eink')).toBeVisible();
    await expect(page.getByRole('button', { name: '‹ Prev' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next ›' })).toBeVisible();
    // E-Ink cover status uses text-only percentage ("62 %"), progress bar hidden
    await expect(page.getByText('62 %')).toBeVisible();

    await assertEinkDomPurity(page, 'E-Ink Library PagedList');
    await assertStrictTwoColorHistogram(page, 'E-Ink Library PagedList');

    // [P1-4] Focused non-empty Library search input passes strict 2-colour histogram (zero native cancel icon)
    const libSearch = page.getByRole('searchbox');
    await libSearch.fill('Cities');
    await assertEinkDomPurity(page, 'E-Ink Library Search Focused');
    await assertStrictTwoColorHistogram(page, 'E-Ink Library Search Focused');
    await libSearch.fill('');

    // Navigate to Settings -> verify E-Ink PagedList + On/Off 2px-bordered toggles (READING + ABOUT only, zero TTS rows in Settings)
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-screen')).toBeVisible();
    await expect(page.locator('[data-setting-row="voice"]')).toHaveCount(0);
    await expect(page.locator('[data-setting-row="on-device-neural-voice"]')).toHaveCount(0);
    await expect(page.locator('[data-setting-row="local-gpu-server"]')).toHaveCount(0);
    await assertEinkDomPurity(page, 'E-Ink Settings (READING + ABOUT)');
    await assertStrictTwoColorHistogram(page, 'E-Ink Settings (READING + ABOUT)');

    // Return to Library and open Lu Xun CJK book (with ruby & footnote skip nodes)
    await page.getByRole('button', { name: 'Back to Library' }).click();
    await page.getByRole('button', { name: /呐喊/ }).click();
    await page.waitForSelector('iframe.mb-reader-frame');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
          return iframe?.contentDocument?.body?.textContent?.includes('我冒了严寒') ?? false;
        }),
      )
      .toBe(true);

    await assertEinkDomPurity(page, 'E-Ink Bare Reader');
    await assertStrictTwoColorHistogram(page, 'E-Ink Bare Reader', {
      expectStructuralBorders: false,
    });

    // Summon Chrome -> verify 6 controls (incl. Manual Full Refresh) + stepped scrubber (`‹ Chapter`, `Go to %`)
    const box = await page.locator('iframe.mb-reader-frame').first().boundingBox();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);

    await expect(page.getByRole('button', { name: 'Full refresh' })).toBeVisible();
    expect(await page.locator('.mb-chrome-top button').count()).toBe(6);
    await expect(page.getByRole('button', { name: 'Go to %' })).toBeVisible();

    await assertEinkDomPurity(page, 'E-Ink 6-Control Chrome');
    await assertStrictTwoColorHistogram(page, 'E-Ink 6-Control Chrome');

    // [P1-4] Focused Go to % input passes strict 2-colour histogram (zero native spin buttons)
    await page.getByRole('button', { name: 'Go to %' }).click();
    await assertEinkDomPurity(page, 'E-Ink Go to % Focused');
    await assertStrictTwoColorHistogram(page, 'E-Ink Go to % Focused');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // [P0-1] & [P1-4] Contents sheet packs multi-row PagedList & focused Search input passes strict histogram
    if (!(await page.locator('.mb-chrome-top').count())) {
      await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    }
    await page.getByRole('button', { name: 'Contents', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Contents' })).toBeVisible();
    expect(await page.locator('.mb-sheet .mb-paged-footer').count()).toBe(0);
    await page.getByRole('dialog').getByText('Search', { exact: true }).click();
    await page.getByRole('dialog').locator('input').fill('我');
    await expect
      .poll(async () => page.locator('.mb-sheet .mb-paged-eink-viewport button').count())
      .toBeGreaterThanOrEqual(2);
    await assertEinkDomPurity(page, 'E-Ink Book Search Focused');
    await assertStrictTwoColorHistogram(page, 'E-Ink Book Search Focused');
    await page.keyboard.press('Escape'); // blur input
    await page.keyboard.press('Escape'); // close Contents sheet (triggers tall-sheet E-Ink refresh!)
    await expect(page.getByRole('dialog', { name: 'Contents' })).toHaveCount(0);

    // Open Appearance sheet (`Aa`) -> verify Text boldness replaces theme swatches
    if (!(await page.locator('.mb-chrome-top').count())) {
      await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    }
    await page.getByRole('button', { name: 'Appearance' }).click();
    await expect(page.getByRole('dialog', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByText('Text boldness')).toBeVisible();

    await assertEinkDomPurity(page, 'E-Ink Appearance Sheet');
    await assertStrictTwoColorHistogram(page, 'E-Ink Appearance Sheet');

    // Close Appearance sheet, start Read Aloud -> verify 2px solid #000000 sentence underline & zero word highlight
    await page.keyboard.press('Escape');
    if (!(await page.locator('.mb-chrome-top').count())) {
      await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    }
    await page.getByRole('button', { name: 'Read aloud' }).click();

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[style*="visibility: visible"]',
          );
          return iframe?.contentDocument?.querySelectorAll('.mb-hl-overlay-eink-line').length ?? 0;
        }),
      )
      .toBeGreaterThan(0);

    await expect(page.locator('.mb-tts-bar')).toBeVisible();
    await expect(page.getByTestId('tts-bar-voice-btn')).toBeVisible();
    await assertEinkDomPurity(page, 'E-Ink Read Aloud Bar');
    await assertStrictTwoColorHistogram(page, 'E-Ink Read Aloud Bar');

    // [P0-2] Center tap cycles ReadAloudBar -> Chrome -> Bare page (underline only) -> ReadAloudBar
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await expect(page.locator('.mb-chrome-top')).toBeVisible();
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await expect(page.locator('.mb-chrome-top')).toHaveCount(0);
    await expect(page.locator('.mb-tts-bar')).toHaveCount(0);
    await assertEinkDomPurity(page, 'E-Ink Read Aloud Underline');
    await assertStrictTwoColorHistogram(page, 'E-Ink Read Aloud Underline');

    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await expect(page.locator('.mb-tts-bar')).toBeVisible();
    await expect(page.getByTestId('tts-bar-voice-btn')).toBeVisible();

    // [v0.2.3] Open Guided 3-Tab VoiceSheet directly from ReadAloudBar -> verify strict 2-colour histogram on all 3 tabs!
    await page.getByTestId('tts-bar-voice-btn').click();
    await expect(page.getByRole('dialog', { name: 'Voice and speed' })).toBeVisible();
    await expect(page.getByTestId('tts-guide-system')).toBeVisible();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet System Tab');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet System Tab');

    // Tab 2: On-Device (Kokoro) -> absent, downloading (stepped [ 45% ] & hidden progress bar), ready, and expanded 103 voices PagedList
    await page.getByRole('tab', { name: 'On-Device' }).click();
    await expect(page.getByTestId('tts-guide-on-device')).toBeVisible();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet On-Device (Absent)');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet On-Device (Absent)');

    await page.evaluate(() => {
      window.__minibookTestHarness?.host.setModelStatus({
        state: 'downloading',
        bytesDone: 45_000_000,
        bytesTotal: 100_000_000,
        source: 'hf-mirror.com',
      });
    });
    await expect(page.getByTestId('kokoro-status-text')).toContainText('[ 45% ]');
    const progressDisplay = await page
      .getByTestId('kokoro-progress-track')
      .evaluate((el) => window.getComputedStyle(el).display);
    expect(progressDisplay).toBe('none');
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet On-Device (Downloading)');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet On-Device (Downloading)');

    await page.evaluate(() => {
      window.__minibookTestHarness?.host.setModelStatus({
        state: 'ready',
        bytesDone: 129_967_797,
        bytesTotal: 129_967_797,
        installedBytes: 129_967_797,
        installedVoices: ['zf_001', 'zm_010', 'af_maple', 'af_sol', 'bf_vale'],
      });
    });
    const moreVoicesBtn = page.getByTestId('kokoro-more-voices-btn');
    if ((await moreVoicesBtn.count()) === 0) {
      await page.getByRole('button', { name: 'Next ›' }).click();
    }
    await expect(moreVoicesBtn).toBeVisible();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet On-Device (Ready)');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet On-Device (Ready)');

    await moreVoicesBtn.click();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet Kokoro 103 Voices PagedList');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet Kokoro 103 Voices PagedList');

    // Tab 3: Server (LAN GPU, OpenAI API, Edge Online)
    await page.getByRole('tab', { name: 'Server' }).click();
    await expect(page.getByTestId('tts-guide-server')).toBeVisible();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet Server LAN GPU');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet Server LAN GPU');

    await page.getByRole('tab', { name: 'OpenAI API' }).click();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet Server OpenAI');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet Server OpenAI');

    await page.getByRole('tab', { name: 'Edge Online' }).click();
    await assertEinkDomPurity(page, 'E-Ink VoiceSheet Server Edge');
    await assertStrictTwoColorHistogram(page, 'E-Ink VoiceSheet Server Edge');
    await page.keyboard.press('Escape');
  });

  test('packs every PagedList item inside viewport with zero clipping across 4 E-Ink viewports & turns pages during Read Aloud', async ({
    browser,
  }) => {
    const assertZeroClipping = async (page: Page, label: string): Promise<void> => {
      const clipped = await page.evaluate(() => {
        const issues: string[] = [];
        for (const container of Array.from(
          document.querySelectorAll('.mb-paged-eink-viewport, .mb-sheet'),
        )) {
          if (!container.getClientRects().length) continue;
          const cr = container.getBoundingClientRect();
          if (
            container.scrollHeight > container.clientHeight + 2 ||
            container.scrollWidth > container.clientWidth + 2
          ) {
            issues.push(
              `${container.className}: scroll ${container.scrollWidth}x${container.scrollHeight} > client ${container.clientWidth}x${container.clientHeight}`,
            );
          }
          for (const item of Array.from(
            container.querySelectorAll(
              'button, input, [role="button"], .mb-list-row, .mb-sheet-row, [data-setting-row]',
            ),
          )) {
            const ir = item.getBoundingClientRect();
            if (ir.width <= 0) continue;
            if (ir.bottom > cr.bottom + 1 || ir.top < cr.top - 1 || ir.right > cr.right + 1) {
              issues.push(
                `${container.className} -> ${(item.getAttribute('aria-label') || item.textContent || '').trim().slice(0, 24)} [${Math.round(ir.top)}..${Math.round(ir.bottom)} vs ${Math.round(cr.top)}..${Math.round(cr.bottom)}]`,
              );
            }
          }
        }
        return issues;
      });
      expect(clipped, `Zero-clipping violation on ${label}`).toEqual([]);
    };

    for (const vp of [
      { width: 758, height: 1024 },
      { width: 600, height: 800 },
      { width: 1072, height: 1448 },
      { width: 1024, height: 600 },
    ]) {
      const context = await browser.newContext({ viewport: vp });
      const page = await context.newPage();
      await page.goto('/?eink=on&platform=android&extraBooks=10');
      await expect(page.getByTestId('paged-list-eink')).toBeVisible();
      await assertZeroClipping(page, `${vp.width}x${vp.height} Library`);

      await page.getByRole('button', { name: 'Settings' }).click();
      await expect(page.getByTestId('settings-screen')).toBeVisible();
      await assertZeroClipping(page, `${vp.width}x${vp.height} Settings p1`);
      const nextBtn = page.getByRole('button', { name: 'Next ›' });
      if ((await nextBtn.count()) > 0 && (await nextBtn.isEnabled())) {
        await nextBtn.click();
        await assertZeroClipping(page, `${vp.width}x${vp.height} Settings p2`);
      }

      await page.getByRole('button', { name: 'Back to Library' }).click();
      await page.getByRole('button', { name: /Tale of Two Cities/ }).first().click();
      await page.waitForSelector('iframe.mb-reader-frame');
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const f = document.querySelector<HTMLIFrameElement>('iframe.mb-reader-frame');
            return (f?.contentDocument?.body?.textContent?.length ?? 0) > 100;
          }),
        )
        .toBe(true);

      await page.mouse.click(vp.width / 2, vp.height / 2);
      await page.getByRole('button', { name: 'Contents', exact: true }).first().click();
      await expect(page.getByRole('dialog', { name: 'Contents' })).toBeVisible();
      // [P0-1] All 3 TOC entries of A Tale of Two Cities fit on 1 page without 1/3 footer!
      expect(await page.locator('.mb-sheet .mb-paged-eink-viewport button').count()).toBe(3);
      expect(await page.locator('.mb-sheet .mb-paged-footer').count()).toBe(0);
      await assertZeroClipping(page, `${vp.width}x${vp.height} Contents`);

      // On 758x1024 also verify [P0-2]: side-zone tap turns page even while Read Aloud is active
      if (vp.width === 758) {
        await page.keyboard.press('Escape');
        if (!(await page.locator('.mb-chrome-top').count())) {
          await page.mouse.click(vp.width / 2, vp.height / 2);
        }
        await page.getByRole('button', { name: 'Read aloud' }).click();
        await expect
          .poll(async () =>
            page.evaluate(() => window.__minibookTestHarness.speech.currentUtterance()?.id ?? null),
          )
          .not.toBeNull();
        const beforeScroll = await page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[style*="visibility: visible"]',
          );
          return f?.contentDocument?.documentElement.scrollLeft ?? 0;
        });
        await page.mouse.click(Math.round(vp.width * 0.9), Math.round(vp.height * 0.5));
        await expect
          .poll(async () =>
            page.evaluate(() => {
              const f = document.querySelector<HTMLIFrameElement>(
                'iframe.mb-reader-frame[style*="visibility: visible"]',
              );
              return f?.contentDocument?.documentElement.scrollLeft ?? 0;
            }),
          )
          .toBeGreaterThan(beforeScroll);
      }

      await context.close();
    }
  });
});
