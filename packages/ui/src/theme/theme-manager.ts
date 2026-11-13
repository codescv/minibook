import type { AppSettings, HostCapabilities } from '@minibook/core';

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

/**
 * Applies `data-theme` and `data-eink` onto `document.documentElement` (`UI_SPEC.md` §2.1):
 * - E-Ink active: `dataset.eink = '1'`; E-Ink off: `delete dataset.eink`.
 * - `matchSystemTheme === true`: removes `data-theme` when system is dark (`Quiet` via `@media`)
 *   or sets `original` / `quiet` cleanly so CSS and JS stay in lockstep.
 */
export function applyDocumentTheme(
  settings: Pick<AppSettings, 'theme' | 'matchSystemTheme' | 'textBoldness'>,
  isEink: boolean,
  doc: Document = document,
): void {
  const root = doc.documentElement;
  if (isEink) {
    root.dataset.eink = '1';
  } else {
    delete root.dataset.eink;
  }

  if (settings.matchSystemTheme) {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = settings.theme;
  }

  root.style.setProperty('--mb-bold', String(isEink ? settings.textBoldness : 0));
}

export function resolveActiveThemeColors(
  settings: Pick<AppSettings, 'theme' | 'matchSystemTheme'>,
  isEink: boolean,
): { bg: string; fg: string; fgQuiet: string; line: string; accent: string; hlSentence: string; hlWord: string } {
  if (isEink) {
    return {
      bg: '#FFFFFF',
      fg: '#000000',
      fgQuiet: '#000000',
      line: '#000000',
      accent: '#000000',
      hlSentence: 'transparent',
      hlWord: 'none',
    };
  }
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const effective = settings.matchSystemTheme ? (prefersDark ? 'quiet' : 'original') : settings.theme;

  switch (effective) {
    case 'paper':
      return {
        bg: '#EEEDE8',
        fg: '#2A2926',
        fgQuiet: '#686660',
        line: '#DAD8D0',
        accent: '#007AFF',
        hlSentence: 'rgba(0, 122, 255, 0.13)',
        hlWord: '2px solid #0066D6',
      };
    case 'calm':
      return {
        bg: '#F4ECD8',
        fg: '#3B3024',
        fgQuiet: '#786855',
        line: '#DFD3B8',
        accent: '#007AFF',
        hlSentence: 'rgba(168, 104, 18, 0.16)',
        hlWord: '2px solid #8A540C',
      };
    case 'quiet':
      return {
        bg: '#2C2C2E',
        fg: '#D8D8DC',
        fgQuiet: '#98989F',
        line: '#444448',
        accent: '#0A84FF',
        hlSentence: 'rgba(10, 132, 255, 0.22)',
        hlWord: '2px solid #409CFF',
      };
    case 'original':
    default:
      return {
        bg: '#FFFFFF',
        fg: '#1C1C1E',
        fgQuiet: '#6E6E73',
        line: '#E5E5EA',
        accent: '#007AFF',
        hlSentence: 'rgba(0, 122, 255, 0.11)',
        hlWord: '2px solid #007AFF',
      };
  }
}
