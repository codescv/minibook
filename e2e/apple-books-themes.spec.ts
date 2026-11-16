import { expect, test } from '@playwright/test';

function rgbToHex(rgb: string): string {
  const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return rgb.trim().toUpperCase();
  const hex = [m[1]!, m[2]!, m[3]!]
    .map((n) => Number(n).toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return `#${hex}`;
}

test.describe('Apple Books Orthogonal Appearance (Light / Dark / Match System) & Per-Theme Palettes', () => {
  test('selecting Calm + Match System preserves #F4ECD8 in light mode, live-switches to Calm Dark #2B251E in dark mode, and switches back to #F4ECD8 in light mode', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/?book=b_dickens');
    await page.waitForSelector('iframe.mb-reader-frame[data-frame-role="active"]');

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const f = document.querySelector<HTMLIFrameElement>(
            'iframe.mb-reader-frame[data-frame-role="active"]',
          );
          return f?.contentDocument?.body?.textContent?.includes('best of times') ?? false;
        }),
      )
      .toBe(true);

    // Open Appearance sheet via keyboard shortcut ('a')
    await page.keyboard.press('a');
    const dialog = page.getByRole('dialog', { name: 'Appearance' });
    await expect(dialog).toBeVisible();

    const appearanceTabs = dialog.getByRole('tablist', { name: 'Appearance' });
    await expect(appearanceTabs).toBeVisible();
    const lightTab = appearanceTabs.getByRole('tab', { name: 'Light' });
    const darkTab = appearanceTabs.getByRole('tab', { name: 'Dark' });
    const systemTab = appearanceTabs.getByRole('tab', { name: 'Match System' });

    // Default appearanceMode is 'system'
    await expect(systemTab).toHaveAttribute('aria-selected', 'true');

    // Select Calm swatch; Match System must stay selected (orthogonal axes)
    const calmSwatch = dialog.getByRole('radio', { name: 'Calm' });
    await calmSwatch.click();
    await expect(calmSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(systemTab).toHaveAttribute('aria-selected', 'true');

    const readThemeColors = async () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const rootCs = window.getComputedStyle(root);
        const activeFrame = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[data-frame-role="active"]',
        )!;
        const fDoc = activeFrame.contentDocument!;
        const fWin = activeFrame.contentWindow!;
        const frameHtmlBg = fWin.getComputedStyle(fDoc.documentElement).backgroundColor;
        const firstP = fDoc.querySelector('p');
        const frameTextFg = firstP ? fWin.getComputedStyle(firstP).color : '';

        const nextFrame = document.querySelector<HTMLIFrameElement>(
          'iframe.mb-reader-frame[data-frame-role="next"]',
        );
        const nextBg =
          nextFrame?.contentDocument && nextFrame.contentWindow
            ? nextFrame.contentWindow.getComputedStyle(nextFrame.contentDocument.documentElement)
                .backgroundColor
            : null;

        const swatchEl = document.querySelector<HTMLElement>('.mb-swatch[data-swatch="calm"]');
        const swatchBg = swatchEl ? window.getComputedStyle(swatchEl).backgroundColor : '';

        return {
          dataTheme: root.dataset.theme ?? '',
          dataAppearance: root.dataset.appearance ?? '',
          tokenBg: rootCs.getPropertyValue('--mb-bg').trim().toUpperCase(),
          frameHtmlBg,
          frameTextFg,
          nextBg,
          swatchBg,
        };
      });

    // 1. OS colorScheme: 'light' -> Calm Light (#F4ECD8 bg, #3B3024 fg)
    await expect
      .poll(async () => {
        const c = await readThemeColors();
        return {
          dataTheme: c.dataTheme,
          dataAppearance: c.dataAppearance,
          tokenBg: c.tokenBg,
          frameBg: rgbToHex(c.frameHtmlBg),
          frameFg: rgbToHex(c.frameTextFg),
          swatchBg: rgbToHex(c.swatchBg),
        };
      })
      .toEqual({
        dataTheme: 'calm',
        dataAppearance: 'system',
        tokenBg: '#F4ECD8',
        frameBg: '#F4ECD8',
        frameFg: '#3B3024',
        swatchBg: '#F4ECD8',
      });

    // 2. Flip OS colorScheme -> 'dark': live-switches to Calm Dark (#2B251E bg, #DDD2C0 fg) without reload
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(async () => {
        const c = await readThemeColors();
        return {
          dataTheme: c.dataTheme,
          dataAppearance: c.dataAppearance,
          tokenBg: c.tokenBg,
          frameBg: rgbToHex(c.frameHtmlBg),
          frameFg: rgbToHex(c.frameTextFg),
          swatchBg: rgbToHex(c.swatchBg),
        };
      })
      .toEqual({
        dataTheme: 'calm',
        dataAppearance: 'system',
        tokenBg: '#2B251E',
        frameBg: '#2B251E',
        frameFg: '#DDD2C0',
        swatchBg: '#2B251E',
      });

    // Pre-rendered next chapter neighbor frame also updates to Calm Dark (#2B251E)
    await expect
      .poll(async () => {
        const c = await readThemeColors();
        return c.nextBg ? rgbToHex(c.nextBg) : null;
      })
      .toBe('#2B251E');

    // 3. Flip OS colorScheme -> 'light': live-switches back to Calm Light (#F4ECD8 bg, #3B3024 fg)
    await page.emulateMedia({ colorScheme: 'light' });
    await expect
      .poll(async () => {
        const c = await readThemeColors();
        return {
          dataTheme: c.dataTheme,
          dataAppearance: c.dataAppearance,
          tokenBg: c.tokenBg,
          frameBg: rgbToHex(c.frameHtmlBg),
          frameFg: rgbToHex(c.frameTextFg),
          swatchBg: rgbToHex(c.swatchBg),
        };
      })
      .toEqual({
        dataTheme: 'calm',
        dataAppearance: 'system',
        tokenBg: '#F4ECD8',
        frameBg: '#F4ECD8',
        frameFg: '#3B3024',
        swatchBg: '#F4ECD8',
      });

    // 4. Explicit Dark / Light override across all 4 themes regardless of OS colorScheme
    await darkTab.click();
    await expect(darkTab).toHaveAttribute('aria-selected', 'true');
    for (const [label, expectedDarkBg] of [
      ['Calm', '#2B251E'],
      ['Original', '#141416'],
      ['Paper', '#232220'],
      ['Quiet', '#2C2C2E'],
    ] as const) {
      await dialog.getByRole('radio', { name: label }).click();
      await expect(darkTab).toHaveAttribute('aria-selected', 'true');
      await expect
        .poll(async () => rgbToHex((await readThemeColors()).frameHtmlBg))
        .toBe(expectedDarkBg);
    }

    // Even when OS is dark, explicit Light uses Quiet Light (#F2F2F7) and Calm Light (#F4ECD8)
    await page.emulateMedia({ colorScheme: 'dark' });
    await lightTab.click();
    await expect(lightTab).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () => rgbToHex((await readThemeColors()).frameHtmlBg))
      .toBe('#F2F2F7');

    await dialog.getByRole('radio', { name: 'Calm' }).click();
    await expect(lightTab).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(async () => rgbToHex((await readThemeColors()).frameHtmlBg))
      .toBe('#F4ECD8');
  });
});
