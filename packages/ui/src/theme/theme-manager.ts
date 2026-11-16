import type { AppSettings, AppearanceMode, HostCapabilities, ReadingTheme } from '@minibook/core';

export function detectMediaEink(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return (
      window.matchMedia('(update: slow)').matches ||
      window.matchMedia('(monochrome)').matches
    );
  } catch {
    return false;
  }
}

export function computeEffectiveEink(
  settings: Pick<AppSettings, 'einkMode'>,
  capabilities: Pick<HostCapabilities, 'einkDetected'>,
  mediaQueryHit = detectMediaEink(),
): boolean {
  if (settings.einkMode === 'on') return true;
  if (settings.einkMode === 'off') return false;
  return Boolean(capabilities.einkDetected || mediaQueryHit);
}

export function computeEffectiveVolumeKeyPaging(
  settings: Pick<AppSettings, 'volumeKeyPaging'>,
  isEink: boolean,
  capabilities: Pick<HostCapabilities, 'volumeKeyPaging'>,
): boolean {
  if (!capabilities.volumeKeyPaging) return false;
  if (settings.volumeKeyPaging !== null) return settings.volumeKeyPaging;
  return isEink;
}

export type ResolvedAppearance = 'light' | 'dark';

type AppearanceSettings = Pick<AppSettings, 'theme' | 'matchSystemTheme'> &
  Partial<Pick<AppSettings, 'appearanceMode'>>;

/** Current OS `prefers-color-scheme: dark` state (`false` outside a browser). */
export function detectPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * Subscribes to live OS light/dark changes (`prefers-color-scheme`). Returns an unsubscribe
 * function; a no-op outside a browser.
 */
export function subscribePrefersDark(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let mq: MediaQueryList;
  try {
    mq = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return () => {};
  }
  const handler = (e: MediaQueryListEvent | MediaQueryList): void => onChange(e.matches);
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }
  // Legacy Safari / WebView (< 14)
  const legacy = mq as MediaQueryList & {
    addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
    removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener?.(handler);
  return () => legacy.removeListener?.(handler);
}

/** Effective `AppearanceMode`, deriving it from the legacy `matchSystemTheme` flag when absent. */
export function resolveAppearanceMode(settings: AppearanceSettings): AppearanceMode {
  const mode = settings.appearanceMode;
  if (mode === 'system' || mode === 'light' || mode === 'dark') return mode;
  if (settings.matchSystemTheme) return 'system';
  return settings.theme === 'quiet' ? 'dark' : 'light';
}

/** `true` when the Dark palette of the active theme should be shown. */
export function resolveEffectiveDark(
  settings: AppearanceSettings,
  prefersDark: boolean = detectPrefersDark(),
): boolean {
  const mode = resolveAppearanceMode(settings);
  return mode === 'dark' || (mode === 'system' && prefersDark);
}

/**
 * Applies `data-theme`, `data-appearance` and `data-eink` onto `document.documentElement`
 * (`UI_SPEC.md` §2.1, Apple Books Appearance):
 * - E-Ink active: `dataset.eink = '1'`; E-Ink off: `delete dataset.eink`.
 * - `data-theme` is ALWAYS the selected reading theme (`original | paper | calm | quiet`).
 * - `data-appearance` is `light | dark | system`; `themes.css` picks the theme's Light or Dark
 *   palette from it (`system` follows `@media (prefers-color-scheme: dark)`).
 */
export function applyDocumentTheme(
  settings: AppearanceSettings & Pick<AppSettings, 'textBoldness'>,
  isEink: boolean,
  doc: Document = document,
): void {
  const root = doc.documentElement;
  if (isEink) {
    root.dataset.eink = '1';
  } else {
    delete root.dataset.eink;
  }

  root.dataset.theme = settings.theme;
  root.dataset.appearance = resolveAppearanceMode(settings);

  root.style.setProperty('--mb-bold', String(isEink ? settings.textBoldness : 0));
}

export interface ActiveThemeColors {
  bg: string;
  fg: string;
  fgQuiet: string;
  line: string;
  accent: string;
  hlSentence: string;
  hlWord: string;
}

/**
 * Per-theme Light & Dark palettes (mirrors `themes.css`; keep both in lockstep).
 */
export const THEME_PALETTES: Readonly<
  Record<ReadingTheme, Readonly<Record<ResolvedAppearance, Readonly<ActiveThemeColors>>>>
> = {
  original: {
    light: {
      bg: '#FFFFFF',
      fg: '#1C1C1E',
      fgQuiet: '#6E6E73',
      line: '#E5E5EA',
      accent: '#007AFF',
      hlSentence: 'rgba(0, 122, 255, 0.11)',
      hlWord: '2px solid #007AFF',
    },
    dark: {
      bg: '#141416',
      fg: '#E5E5EA',
      fgQuiet: '#98989F',
      line: '#2C2C2E',
      accent: '#0A84FF',
      hlSentence: 'rgba(10, 132, 255, 0.24)',
      hlWord: '2px solid #409CFF',
    },
  },
  paper: {
    light: {
      bg: '#EEEDE8',
      fg: '#2A2926',
      fgQuiet: '#686660',
      line: '#DAD8D0',
      accent: '#007AFF',
      hlSentence: 'rgba(0, 122, 255, 0.13)',
      hlWord: '2px solid #0066D6',
    },
    dark: {
      bg: '#232220',
      fg: '#D6D4CE',
      fgQuiet: '#96938B',
      line: '#3A3834',
      accent: '#0A84FF',
      hlSentence: 'rgba(10, 132, 255, 0.22)',
      hlWord: '2px solid #409CFF',
    },
  },
  calm: {
    light: {
      bg: '#F4ECD8',
      fg: '#3B3024',
      fgQuiet: '#786855',
      line: '#DFD3B8',
      accent: '#007AFF',
      hlSentence: 'rgba(168, 104, 18, 0.16)',
      hlWord: '2px solid #8A540C',
    },
    dark: {
      bg: '#2B251E',
      fg: '#DDD2C0',
      fgQuiet: '#A39580',
      line: '#443A2E',
      accent: '#0A84FF',
      hlSentence: 'rgba(222, 160, 64, 0.22)',
      hlWord: '2px solid #D9A04A',
    },
  },
  quiet: {
    light: {
      bg: '#F2F2F7',
      fg: '#2C2C2E',
      fgQuiet: '#6E6E73',
      line: '#DCDCE2',
      accent: '#007AFF',
      hlSentence: 'rgba(0, 122, 255, 0.12)',
      hlWord: '2px solid #007AFF',
    },
    dark: {
      bg: '#2C2C2E',
      fg: '#D8D8DC',
      fgQuiet: '#98989F',
      line: '#444448',
      accent: '#0A84FF',
      hlSentence: 'rgba(10, 132, 255, 0.22)',
      hlWord: '2px solid #409CFF',
    },
  },
};

const EINK_COLORS: Readonly<ActiveThemeColors> = {
  bg: '#FFFFFF',
  fg: '#000000',
  fgQuiet: '#000000',
  line: '#000000',
  accent: '#000000',
  hlSentence: 'transparent',
  hlWord: 'none',
};

/**
 * Exact Light or Dark palette of `settings.theme` for the iframe user stylesheet / highlighter,
 * chosen by `resolveEffectiveDark(settings)` (E-Ink always forces 1-bit black on white).
 */
export function resolveActiveThemeColors(
  settings: AppearanceSettings,
  isEink: boolean,
  prefersDark: boolean = detectPrefersDark(),
): ActiveThemeColors {
  if (isEink) return { ...EINK_COLORS };
  const palettes = THEME_PALETTES[settings.theme] ?? THEME_PALETTES.original;
  return { ...palettes[resolveEffectiveDark(settings, prefersDark) ? 'dark' : 'light'] };
}
