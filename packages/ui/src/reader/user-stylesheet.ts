import type { AppSettings } from '@minibook/core';
import type { PaginationGeometry } from './Paginator';
import { resolveActiveThemeColors } from '../theme/theme-manager';

const SERIF_STACK_ZH_HANS =
  '"Literata", "Georgia", "Bitstream Charter", "Charter", "Songti SC", "STSongti-SC-Regular", "STSong", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "PingFang SC", "PingFang TC", "Heiti SC", serif';

const SERIF_STACK_ZH_HANT =
  '"Literata", "Georgia", "Bitstream Charter", "Charter", "Songti TC", "STSongti-TC-Regular", "STSong", "Noto Serif CJK TC", "Noto Serif TC", "Source Han Serif TC", "PingFang TC", "PingFang SC", "Heiti TC", serif';

const SERIF_STACK_JA =
  '"Literata", "Georgia", "Bitstream Charter", "Charter", "Hiragino Mincho ProN", "Hiragino Mincho", "YuMincho", "Yu Mincho", "Noto Serif CJK JP", "Noto Serif JP", "Source Han Serif JP", "Hiragino Sans", "PingFang SC", serif';

const SANS_STACK_ZH_HANS =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "PingFang TC", "Heiti SC", "Inter", "Roboto", system-ui, "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", sans-serif';

const SANS_STACK_ZH_HANT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang TC", "PingFang SC", "Heiti TC", "Inter", "Roboto", system-ui, "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC", sans-serif';

const SANS_STACK_JA =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Inter", "Roboto", system-ui, "Noto Sans CJK JP", "Noto Sans JP", "Source Han Sans JP", "PingFang SC", sans-serif';

export function resolveBookSerifStack(bookLang: string | null | undefined): string {
  const tag = (bookLang ?? '').trim().toLowerCase();
  if (/^(?:ja(?=$|[-_])|jpn\b)/.test(tag)) {
    return SERIF_STACK_JA;
  }
  if (/^zh[-_](?:tw|hk|mo|hant)\b/.test(tag)) {
    return SERIF_STACK_ZH_HANT;
  }
  return SERIF_STACK_ZH_HANS;
}

export function resolveBookSansStack(bookLang: string | null | undefined): string {
  const tag = (bookLang ?? '').trim().toLowerCase();
  if (/^(?:ja(?=$|[-_])|jpn\b)/.test(tag)) {
    return SANS_STACK_JA;
  }
  if (/^zh[-_](?:tw|hk|mo|hant)\b/.test(tag)) {
    return SANS_STACK_ZH_HANT;
  }
  return SANS_STACK_ZH_HANS;
}

export function computeBookLineHeight(
  preset: AppSettings['lineSpacing'],
  isEink: boolean,
  bookLang: string | null,
): number {
  const effectivePreset = isEink && preset === 'tight' ? 'normal' : preset;
  const base =
    effectivePreset === 'tight' ? 1.45 : effectivePreset === 'loose' ? 1.8 : 1.6;
  const isCjk = Boolean(bookLang && /^(zh|ja)/i.test(bookLang));
  return Math.round((base + (isCjk ? 0.1 : 0)) * 100) / 100;
}

export function buildFrameUserStylesheet(options: {
  readonly settings: AppSettings;
  readonly isEink: boolean;
  readonly geom: PaginationGeometry;
  readonly bookLang: string | null;
  readonly isCoverLike?: boolean;
  readonly literataFontCss?: string;
}): string {
  const { settings, isEink, geom, bookLang, isCoverLike = false, literataFontCss = '' } = options;
  const colors = resolveActiveThemeColors(settings, isEink);
  const lineHeight = computeBookLineHeight(settings.lineSpacing, isEink, bookLang);
  const isCjk = Boolean(bookLang && /^(zh|ja)/i.test(bookLang));
  const indent = isCjk ? '2em' : '1.5em';
  const maxMediaHeight = Math.max(80, geom.contentHeight - Math.round(2 * geom.fontSizePx));

  const serifStack = resolveBookSerifStack(bookLang);
  const sansStack = resolveBookSansStack(bookLang);

  const fontRule =
    settings.fontFamily === 'sans'
      ? `font-family: ${sansStack} !important;`
      : settings.fontFamily === 'serif'
        ? `font-family: ${serifStack} !important;`
        : `font-family: ${serifStack};`;

  const justifyRule = settings.justify
    ? `text-align: justify; hyphens: auto; -webkit-hyphens: auto; line-break: strict; text-justify: inter-character;`
    : `text-align: start; hyphens: manual; -webkit-hyphens: manual;`;

  const paragraphRules =
    settings.fontFamily === 'original'
      ? ''
      : `
    body p {
      margin-top: 0 !important;
      margin-bottom: 0 !important;
      text-indent: ${indent};
    }
    body h1 + p,
    body h2 + p,
    body h3 + p,
    body h4 + p,
    body blockquote + p,
    body hr + p,
    body p.mb-no-indent,
    body p:first-child {
      text-indent: 0;
    }
  `;

  const layoutBodyRules = isCoverLike
    ? `
    body {
      margin: 0 !important;
      box-sizing: content-box !important;
      width: ${geom.Vw - geom.G}px !important;
      height: ${geom.contentHeight}px !important;
      padding: ${geom.pt}px ${geom.G / 2}px ${geom.pb}px ${geom.G / 2}px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
    }
  `
    : `
    body {
      margin: 0 !important;
      box-sizing: content-box !important;
      width: ${geom.Vw - geom.G}px !important;
      height: ${geom.contentHeight}px !important;
      padding: ${geom.pt}px ${geom.G / 2}px ${geom.pb}px ${geom.G / 2}px !important;
      column-width: ${geom.Cw}px !important;
      column-gap: ${geom.G}px !important;
      column-fill: auto !important;
      overflow-wrap: break-word;
      widows: 2;
      orphans: 2;
      user-select: text;
      -webkit-user-select: text;
      line-height: ${lineHeight} !important;
      ${fontRule}
      ${justifyRule}
    }
  `;

  const einkRules = isEink
    ? `
    *, *::before, *::after {
      color: #000000 !important;
      background-color: transparent !important;
      border-color: #000000 !important;
      text-shadow: none !important;
      box-shadow: none !important;
      animation: none !important;
      transition: none !important;
      filter: none !important;
      backdrop-filter: none !important;
      opacity: 1 !important;
      border-radius: 0 !important;
      -webkit-font-smoothing: antialiased;
    }
    html {
      background-color: #FFFFFF !important;
    }
    body {
      font-weight: 500 !important;
      -webkit-text-stroke: ${(settings.textBoldness * 0.2).toFixed(1)}px #000000;
      paint-order: stroke fill;
    }
    a {
      color: #000000 !important;
      text-decoration: underline !important;
    }
    ::selection {
      background: #000000;
      color: #FFFFFF;
    }
    ::highlight(mb-sentence) {
      background: transparent !important;
      background-color: transparent !important;
      text-decoration: underline 2px solid #000000 !important;
      text-underline-offset: 0.18em !important;
    }
    .mb-hl-overlay-eink-line {
      background-color: #000000 !important;
    }
  `
    : `
    body, body *:not(svg):not(svg *):not(.mb-hl-overlay-box) {
      color: ${colors.fg} !important;
      background-color: transparent !important;
    }
    ${settings.fontFamily !== 'original' ? `body *:not(code):not(pre) { ${fontRule} }` : ''}
    a {
      color: ${colors.accent} !important;
      text-decoration: underline !important;
    }
    ::highlight(mb-sentence) {
      background-color: ${colors.hlSentence};
    }
    ::highlight(mb-word) {
      text-decoration: underline ${colors.hlWord};
      text-underline-offset: 0.18em;
    }
    ::highlight(mb-search) {
      background-color: rgba(255, 204, 0, 0.34);
    }
  `;

  return `
    ${literataFontCss}
    html {
      width: ${geom.Vw}px !important;
      height: ${geom.Vh}px !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      -webkit-text-size-adjust: 100%;
      text-size-adjust: 100%;
      touch-action: none;
      background-color: ${colors.bg} !important;
      color: ${colors.fg} !important;
      font-size: ${geom.fontSizePx}px !important;
      position: relative;
    }
    ${layoutBodyRules}
    ${paragraphRules}
    h1, h2, h3, h4, h5, h6 {
      break-after: avoid;
      page-break-after: avoid;
      text-align: start;
      line-height: 1.32;
      margin-top: 0.6em;
      margin-bottom: 0.85em;
    }
    h1:first-child, h2:first-child, h3:first-child {
      margin-top: 0;
    }
    figure, img, svg, video, blockquote {
      break-inside: avoid;
    }
    img, svg, video {
      max-width: 100% !important;
      max-height: ${maxMediaHeight}px !important;
      height: auto;
      object-fit: contain;
    }
    table {
      max-width: 100% !important;
      border-collapse: collapse;
    }
    td, th {
      overflow-wrap: anywhere;
    }
    pre, code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    @supports (text-autospace: normal) {
      body { text-autospace: normal; }
    }
    ${einkRules}
  `;
}
