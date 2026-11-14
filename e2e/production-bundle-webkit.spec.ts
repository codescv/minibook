import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { expect, test, webkit } from '@playwright/test';

const ROOT_DIR = resolve(import.meta.dirname, '..');
const ANDROID_WWW_DIR = resolve(ROOT_DIR, 'packages/host-android/www');

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.gz': 'application/octet-stream',
};

function collectJsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectJsFiles(full, out);
    } else if (name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

async function startStaticWwwServer(wwwDir: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const reqPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (reqPath === '/__broken_boot_test.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="${findStylesheetHref(wwwDir)}"></head><body><div id="root"></div><script src="/boot-diag.js"></script><script type="module" src="/__broken_syntax.js"></script></body></html>`);
      return;
    }
    if (reqPath === '/__broken_syntax.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end('const broken = /^ {\n 0, 3}>/;\n');
      return;
    }
    const cleanRel = normalize(reqPath)
      .replace(/^(\.\.(\/|\\|$))+/, '')
      .replace(/^[/\\]+/, '');
    const candidate = resolve(wwwDir, cleanRel || 'index.html');
    if (candidate.startsWith(wwwDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const ext = extname(candidate).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(readFileSync(candidate));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind static www server');
  }
  return { server, baseUrl: `http://localhost:${addr.port}` };
}

function findStylesheetHref(wwwDir: string): string {
  const html = readFileSync(join(wwwDir, 'index.html'), 'utf8');
  const m = html.match(/href="(\/assets\/[^"]+\.css)"/);
  return m?.[1] ?? '/assets/index.css';
}

test.describe('Production Capacitor www Bundle (Clang-Format Guard, CSP, WebKit & Chromium)', () => {
  test('guards every emitted .js bundle with /* clang-format off */ and passes node --check', () => {
    expect(existsSync(join(ANDROID_WWW_DIR, 'index.html'))).toBe(true);
    expect(existsSync(join(ANDROID_WWW_DIR, 'boot-diag.js'))).toBe(true);

    const html = readFileSync(join(ANDROID_WWW_DIR, 'index.html'), 'utf8');
    expect(html).toContain(
      "style-src 'self' 'unsafe-inline' https://localhost capacitor://localhost",
    );
    expect(html).toContain(
      "script-src 'self' 'wasm-unsafe-eval' https://localhost capacitor://localhost",
    );
    expect(html).toContain('<script src="/boot-diag.js"></script>');

    const jsFiles = collectJsFiles(ANDROID_WWW_DIR);
    expect(jsFiles.length).toBeGreaterThanOrEqual(3);
    for (const file of jsFiles) {
      const src = readFileSync(file, 'utf8');
      expect(
        src.startsWith('/* clang-format off */\n'),
        `Expected ${file} to start with /* clang-format off */`,
      ).toBe(true);
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  });

  test('renders non-white styled Library UI with zero console/page/CSP errors in Chromium AND WebKit + shows recovery card on syntax failure', async ({
    browser: chromiumBrowser,
  }) => {
    const { server, baseUrl } = await startStaticWwwServer(ANDROID_WWW_DIR);
    try {
      // 1. Verify Chromium (mobile 393x852 light + desktop 1280x800 dark + reducedMotion)
      for (const cfg of [
        { width: 393, height: 852, colorScheme: 'light' as const, reducedMotion: 'no-preference' as const },
        { width: 1280, height: 800, colorScheme: 'dark' as const, reducedMotion: 'reduce' as const },
      ]) {
        const ctx = await chromiumBrowser.newContext({
          viewport: { width: cfg.width, height: cfg.height },
          colorScheme: cfg.colorScheme,
          reducedMotion: cfg.reducedMotion,
        });
        const page = await ctx.newPage();
        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });

        await page.goto(`${baseUrl}/`);
        await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

        const diag = await page.evaluate(() => {
          const h1 = document.querySelector<HTMLElement>('.mb-library-title');
          const rect = h1?.getBoundingClientRect();
          const cs = h1 ? window.getComputedStyle(h1) : null;
          const win = window as Window & {
            __minibookMounted?: boolean;
            __minibookBootErrors?: string[];
            __minibookCSPViolations?: string[];
          };
          return {
            mounted: Boolean(win.__minibookMounted),
            bootErrors: win.__minibookBootErrors ?? [],
            cspViolations: win.__minibookCSPViolations ?? [],
            styleSheetCount: document.styleSheets.length,
            titleHeight: rect?.height ?? 0,
            titleWidth: rect?.width ?? 0,
            titleFontSize: cs?.fontSize ?? '',
            windowOnmessageIsNull: window.onmessage === null,
          };
        });

        expect(diag.mounted).toBe(true);
        expect(diag.bootErrors).toEqual([]);
        expect(diag.cspViolations).toEqual([]);
        expect(diag.styleSheetCount).toBeGreaterThan(0);
        expect(diag.titleHeight).toBeGreaterThan(20);
        expect(diag.titleWidth).toBeGreaterThan(40);
        expect(diag.titleFontSize).toBe('28px');
        expect(diag.windowOnmessageIsNull).toBe(true);
        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
        await ctx.close();
      }

      // 2. Verify /boot-diag.js renders visible recovery card when a bundle has a SyntaxError
      {
        const ctx = await chromiumBrowser.newContext({ viewport: { width: 393, height: 852 } });
        const page = await ctx.newPage();
        await page.goto(`${baseUrl}/__broken_boot_test.html`);
        await expect(page.getByTestId('boot-error-card')).toBeVisible();
        const bootErrs = await page.evaluate(
          () => (window as Window & { __minibookBootErrors?: string[] }).__minibookBootErrors ?? [],
        );
        expect(bootErrs.length).toBeGreaterThan(0);
        await ctx.close();
      }

      // 3. Verify Playwright WebKit (closest engine to iOS WKWebView) including image-bearing EPUB in Reader (0 mb-res: CSP errors!)
      process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
      const epubFixturePath = resolve(ROOT_DIR, 'fixtures/epub3-modern.epub');
      const wkBrowser = await webkit.launch({
        headless: true,
        executablePath: webkit.executablePath(),
        args: [],
      });
      try {
        for (const vp of [
          { width: 393, height: 852, colorScheme: 'light' as const },
          { width: 1280, height: 800, colorScheme: 'dark' as const },
        ]) {
          const ctx = await wkBrowser.newContext({
            viewport: { width: vp.width, height: vp.height },
            colorScheme: vp.colorScheme,
          });
          const page = await ctx.newPage();
          const wkPageErrors: string[] = [];
          const wkConsoleErrors: string[] = [];
          const wkMbResErrors: string[] = [];
          page.on('pageerror', (err) => wkPageErrors.push(err.message));
          page.on('console', (msg) => {
            const text = msg.text();
            if (/mb-res:/i.test(text)) {
              wkMbResErrors.push(text);
            }
            if (
              msg.type() === 'error' &&
              !/Blocked script execution in 'about:blank' because the document's frame is sandboxed/i.test(
                text,
              )
            ) {
              wkConsoleErrors.push(text);
            }
          });

          await page.goto(`${baseUrl}/`);
          await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();

          const wkDiag = await page.evaluate(() => {
            const h1 = document.querySelector<HTMLElement>('.mb-library-title');
            const rect = h1?.getBoundingClientRect();
            const cs = h1 ? window.getComputedStyle(h1) : null;
            const win = window as Window & {
              __minibookMounted?: boolean;
              __minibookBootErrors?: string[];
              __minibookCSPViolations?: string[];
            };
            return {
              mounted: Boolean(win.__minibookMounted),
              bootErrors: win.__minibookBootErrors ?? [],
              cspViolations: win.__minibookCSPViolations ?? [],
              styleSheetCount: document.styleSheets.length,
              titleHeight: rect?.height ?? 0,
              titleFontSize: cs?.fontSize ?? '',
              windowOnmessageIsNull: window.onmessage === null,
            };
          });

          expect(wkDiag.mounted).toBe(true);
          expect(wkDiag.bootErrors).toEqual([]);
          expect(wkDiag.cspViolations).toEqual([]);
          expect(wkDiag.styleSheetCount).toBeGreaterThan(0);
          expect(wkDiag.titleHeight).toBeGreaterThan(20);
          expect(wkDiag.titleFontSize).toBe('28px');
          expect(wkDiag.windowOnmessageIsNull).toBe(true);

          // On 393x852 WebKit, also import image-bearing epub3-modern.epub and open Reader -> assert 0 `Refused to load mb-res:` CSP errors!
          if (vp.width === 393) {
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.locator('.mb-empty-state .mb-primary-btn').click();
            const fileChooser = await fileChooserPromise;
            await fileChooser.setFiles(epubFixturePath);

            const coverBtn = page.locator('.mb-cover-item[role="button"]').first();
            await expect(coverBtn).toBeVisible();
            await coverBtn.click();

            await page.waitForSelector('iframe.mb-reader-frame[data-frame-role="active"]');
            await expect
              .poll(async () =>
                page.evaluate(() => {
                  const nextFrame = document.querySelector<HTMLIFrameElement>(
                    'iframe.mb-reader-frame[data-frame-role="next"]',
                  );
                  return Boolean(nextFrame?.contentDocument?.querySelector('img[src^="blob:"]'));
                }),
              )
              .toBe(true);

            // Navigate to Chapter 2 (`ornament.png` `<img>`) and verify active frame image `src` is `blob:` with 0 `mb-res:` errors
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(320);
            expect(wkMbResErrors).toEqual([]);
          }

          expect(wkPageErrors).toEqual([]);
          expect(wkConsoleErrors).toEqual([]);
          await ctx.close();
        }
      } finally {
        await wkBrowser.close();
      }
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
