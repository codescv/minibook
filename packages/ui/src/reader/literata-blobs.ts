import normalLatinUrl from '../theme/fonts/literata-normal-latin.woff2?url';
import normalLatinExtUrl from '../theme/fonts/literata-normal-latin-ext.woff2?url';
import normalCyrillicUrl from '../theme/fonts/literata-normal-cyrillic.woff2?url';
import normalGreekUrl from '../theme/fonts/literata-normal-greek.woff2?url';
import italicLatinUrl from '../theme/fonts/literata-italic-latin.woff2?url';
import italicLatinExtUrl from '../theme/fonts/literata-italic-latin-ext.woff2?url';
import italicCyrillicUrl from '../theme/fonts/literata-italic-cyrillic.woff2?url';
import italicGreekUrl from '../theme/fonts/literata-italic-greek.woff2?url';

interface FontFaceSpec {
  readonly style: 'normal' | 'italic';
  readonly url: string;
  readonly unicodeRange: string;
}

const SPECS: readonly FontFaceSpec[] = [
  {
    style: 'normal',
    url: normalLatinUrl,
    unicodeRange:
      'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    style: 'normal',
    url: normalLatinExtUrl,
    unicodeRange:
      'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
  {
    style: 'normal',
    url: normalCyrillicUrl,
    unicodeRange: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
  },
  {
    style: 'normal',
    url: normalGreekUrl,
    unicodeRange: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF',
  },
  {
    style: 'italic',
    url: italicLatinUrl,
    unicodeRange:
      'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  },
  {
    style: 'italic',
    url: italicLatinExtUrl,
    unicodeRange:
      'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
  {
    style: 'italic',
    url: italicCyrillicUrl,
    unicodeRange: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
  },
  {
    style: 'italic',
    url: italicGreekUrl,
    unicodeRange: 'U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF',
  },
];

let cachedCssPromise: Promise<string> | null = null;

/**
 * Resolves bundled Literata WOFF2 subsets into same-origin `blob:` URLs so
 * `SectionFrame` iframes (`font-src blob: data:`) load Literata with zero CSP errors.
 */
export function getLiterataFrameFontCss(): Promise<string> {
  if (cachedCssPromise) return cachedCssPromise;
  if (typeof window === 'undefined' || typeof fetch !== 'function' || typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    cachedCssPromise = Promise.resolve('');
    return cachedCssPromise;
  }

  cachedCssPromise = (async () => {
    const rules: string[] = [];
    await Promise.all(
      SPECS.map(async (spec) => {
        try {
          const resp = await fetch(spec.url);
          if (!resp.ok) return;
          const buf = await resp.arrayBuffer();
          if (buf.byteLength === 0) return;
          const blob = new Blob([buf], { type: 'font/woff2' });
          const blobUrl = URL.createObjectURL(blob);
          rules.push(
            `@font-face { font-family: "Literata"; font-style: ${spec.style}; font-weight: 400 700; font-display: swap; src: url("${blobUrl}") format("woff2"); unicode-range: ${spec.unicodeRange}; }`,
          );
        } catch {
          // Fallback to system serif cleanly if asset fetch fails in non-Vite test environments
        }
      }),
    );
    return rules.join('\n');
  })();

  return cachedCssPromise;
}
