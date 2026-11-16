import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@minibook/core';
import {
  applyDocumentTheme,
  createMockPlatformHost,
  createMockSpeechPlayer,
  resolveActiveThemeColors,
  resolveAppearanceMode,
  resolveEffectiveDark,
  THEME_PALETTES,
  usePrefersDark,
} from '../index';
import { HostProvider, useSettingsStore } from '../host/HostContext';
import { AppearanceSheet } from '../reader/sheets/Appearance';

const THEMES_CSS = Object.values(
  import.meta.glob<string>('../theme/themes.css', { query: '?raw', import: 'default', eager: true }),
)[0] as string;

type Listener = (e: { matches: boolean }) => void;

/** Controllable `prefers-color-scheme` mock with live `change` events. */
function installColorSchemeMock(initialDark: boolean): { setDark(dark: boolean): void; restore(): void } {
  const original = window.matchMedia;
  let dark = initialDark;
  const listeners = new Set<Listener>();
  const mm = (query: string): MediaQueryList =>
    ({
      get matches() {
        return query.includes('prefers-color-scheme: dark') ? dark : false;
      },
      media: query,
      onchange: null,
      addListener: (cb: Listener) => {
        if (query.includes('prefers-color-scheme')) listeners.add(cb);
      },
      removeListener: (cb: Listener) => listeners.delete(cb),
      addEventListener: (_type: string, cb: Listener) => {
        if (query.includes('prefers-color-scheme')) listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: mm });
  return {
    setDark(next) {
      dark = next;
      for (const cb of [...listeners]) cb({ matches: next });
    },
    restore() {
      Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: original });
    },
  };
}

function settingsWith(patch: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, ...patch };
}

describe('Apple Books Appearance: per-theme Light & Dark palettes', () => {
  let scheme: ReturnType<typeof installColorSchemeMock>;

  beforeEach(() => {
    scheme = installColorSchemeMock(false);
  });

  afterEach(() => {
    scheme.restore();
    const root = document.documentElement;
    delete root.dataset.theme;
    delete root.dataset.appearance;
    delete root.dataset.eink;
    useSettingsStore.getState().reset();
  });

  it('applyDocumentTheme always sets data-theme and the orthogonal data-appearance', () => {
    const root = document.documentElement;
    applyDocumentTheme(settingsWith({ theme: 'calm', appearanceMode: 'system', matchSystemTheme: true }), false);
    expect(root.dataset.theme).toBe('calm');
    expect(root.dataset.appearance).toBe('system');
    expect(root.dataset.eink).toBeUndefined();

    applyDocumentTheme(settingsWith({ theme: 'paper', appearanceMode: 'dark', matchSystemTheme: false }), false);
    expect(root.dataset.theme).toBe('paper');
    expect(root.dataset.appearance).toBe('dark');

    applyDocumentTheme(settingsWith({ theme: 'quiet', appearanceMode: 'light', matchSystemTheme: false }), true);
    expect(root.dataset.theme).toBe('quiet');
    expect(root.dataset.appearance).toBe('light');
    expect(root.dataset.eink).toBe('1');
  });

  it('derives the appearance from legacy matchSystemTheme when appearanceMode is absent', () => {
    expect(resolveAppearanceMode({ theme: 'original', matchSystemTheme: true })).toBe('system');
    expect(resolveAppearanceMode({ theme: 'quiet', matchSystemTheme: false })).toBe('dark');
    expect(resolveAppearanceMode({ theme: 'calm', matchSystemTheme: false })).toBe('light');
    const root = document.documentElement;
    applyDocumentTheme({ theme: 'quiet', matchSystemTheme: false, textBoldness: 0 }, false);
    expect(root.dataset.appearance).toBe('dark');
  });

  it('resolveEffectiveDark follows Light / Dark / Match System', () => {
    const light = settingsWith({ appearanceMode: 'light', matchSystemTheme: false });
    const dark = settingsWith({ appearanceMode: 'dark', matchSystemTheme: false });
    const system = settingsWith({ appearanceMode: 'system', matchSystemTheme: true });
    expect(resolveEffectiveDark(light, true)).toBe(false);
    expect(resolveEffectiveDark(dark, false)).toBe(true);
    expect(resolveEffectiveDark(system, false)).toBe(false);
    expect(resolveEffectiveDark(system, true)).toBe(true);
    // default reads the live media query
    expect(resolveEffectiveDark(system)).toBe(false);
    scheme.setDark(true);
    expect(resolveEffectiveDark(system)).toBe(true);
  });

  it('resolveActiveThemeColors returns the exact Light or Dark palette of the selected theme', () => {
    expect(resolveActiveThemeColors(settingsWith({ theme: 'original', appearanceMode: 'light' }), false).bg).toBe('#FFFFFF');
    expect(resolveActiveThemeColors(settingsWith({ theme: 'original', appearanceMode: 'dark' }), false)).toMatchObject({
      bg: '#141416',
      fg: '#E5E5EA',
      fgQuiet: '#98989F',
      line: '#2C2C2E',
      accent: '#0A84FF',
    });
    expect(resolveActiveThemeColors(settingsWith({ theme: 'paper', appearanceMode: 'dark' }), false)).toMatchObject({
      bg: '#232220',
      fg: '#D6D4CE',
      fgQuiet: '#96938B',
      line: '#3A3834',
    });
    expect(resolveActiveThemeColors(settingsWith({ theme: 'calm', appearanceMode: 'dark' }), false)).toMatchObject({
      bg: '#2B251E',
      fg: '#DDD2C0',
      fgQuiet: '#A39580',
      line: '#443A2E',
    });
    expect(resolveActiveThemeColors(settingsWith({ theme: 'quiet', appearanceMode: 'light' }), false)).toMatchObject({
      bg: '#F2F2F7',
      fg: '#2C2C2E',
      fgQuiet: '#6E6E73',
      line: '#DCDCE2',
      accent: '#007AFF',
    });
    expect(resolveActiveThemeColors(settingsWith({ theme: 'quiet', appearanceMode: 'dark' }), false).bg).toBe('#2C2C2E');

    // Match System picks the theme's own dark palette (no more forced Quiet)
    const calmSystem = settingsWith({ theme: 'calm', appearanceMode: 'system' });
    expect(resolveActiveThemeColors(calmSystem, false, false).bg).toBe('#F4ECD8');
    expect(resolveActiveThemeColors(calmSystem, false, true).bg).toBe('#2B251E');

    // E-Ink always wins
    const eink = resolveActiveThemeColors(settingsWith({ theme: 'calm', appearanceMode: 'dark' }), true);
    expect(eink).toMatchObject({ bg: '#FFFFFF', fg: '#000000' });
  });

  it('themes.css defines a Light and a Dark palette (explicit + Match System) for every theme and swatch', () => {
    for (const id of ['original', 'paper', 'calm', 'quiet'] as const) {
      expect(THEMES_CSS).toContain(`:root[data-theme="${id}"] {`);
      expect(THEMES_CSS).toContain(
        `:root[data-theme="${id}"][data-appearance="dark"]:not([data-eink="1"]):not([data-eink="true"]) {`,
      );
      expect(THEMES_CSS).toContain(
        `:root[data-theme="${id}"][data-appearance="system"]:not([data-eink="1"]):not([data-eink="true"]) {`,
      );
      expect(THEMES_CSS).toContain(`:root[data-appearance="dark"] .mb-swatch[data-swatch="${id}"]`);
      expect(THEMES_CSS).toContain(`:root[data-appearance="system"] .mb-swatch[data-swatch="${id}"]`);
      // Every palette in THEME_PALETTES appears in the stylesheet (CSS & JS in lockstep)
      for (const mode of ['light', 'dark'] as const) {
        const p = THEME_PALETTES[id][mode];
        expect(THEMES_CSS).toContain(`--mb-bg: ${p.bg};`);
        expect(THEMES_CSS).toContain(`--mb-fg: ${p.fg};`);
      }
    }
    // Legacy "no data-theme -> Quiet" mapping is gone
    expect(THEMES_CSS).not.toContain(':root:not([data-theme]):not([data-eink="1"]):not([data-eink="true"]) {');
  });

  it('usePrefersDark re-renders on live OS appearance changes', () => {
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(false);
    act(() => scheme.setDark(true));
    expect(result.current).toBe(true);
    act(() => scheme.setDark(false));
    expect(result.current).toBe(false);
  });

  it('Appearance sheet: 3-way Light / Dark / Match System control, swatches change ONLY the theme', async () => {
    const host = createMockPlatformHost({
      initialSettings: { theme: 'calm', appearanceMode: 'dark', matchSystemTheme: false },
    });
    const speech = createMockSpeechPlayer();
    render(
      <HostProvider host={host} speechPlayer={speech}>
        <AppearanceSheet open onClose={() => {}} />
      </HostProvider>,
    );

    await waitFor(() => {
      expect(useSettingsStore.getState().hydrated).toBe(true);
    });

    const group = await screen.findByRole('tablist', { name: 'Appearance' });
    expect(group).toBeInTheDocument();
    const darkTab = screen.getByRole('tab', { name: 'Dark' });
    expect(darkTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Light' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Match System' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('radio', { name: 'Calm' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('calm');
    expect(document.documentElement.dataset.appearance).toBe('dark');

    // Selecting a swatch keeps the Appearance (Dark) intact
    fireEvent.click(screen.getByRole('radio', { name: 'Paper' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.theme).toBe('paper');
    });
    expect(useSettingsStore.getState().settings.appearanceMode).toBe('dark');
    expect(useSettingsStore.getState().settings.matchSystemTheme).toBe(false);
    expect(screen.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(document.documentElement.dataset.appearance).toBe('dark');

    // Match System keeps the theme and stays active-highlighted
    fireEvent.click(screen.getByRole('tab', { name: 'Match System' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.appearanceMode).toBe('system');
    });
    expect(useSettingsStore.getState().settings.matchSystemTheme).toBe(true);
    expect(useSettingsStore.getState().settings.theme).toBe('paper');
    expect(screen.getByRole('radio', { name: 'Paper' })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.dataset.theme).toBe('paper');
    expect(document.documentElement.dataset.appearance).toBe('system');

    fireEvent.click(screen.getByRole('tab', { name: 'Light' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.appearanceMode).toBe('light');
    });
    expect(useSettingsStore.getState().settings.theme).toBe('paper');
    const persisted = await host.settings.get();
    expect(persisted).toMatchObject({ theme: 'paper', appearanceMode: 'light', matchSystemTheme: false });
  });

  it('mock host keeps legacy matchSystemTheme-only settings consistent', async () => {
    const host = createMockPlatformHost({ initialSettings: { theme: 'quiet', matchSystemTheme: false } });
    expect(await host.settings.get()).toMatchObject({ appearanceMode: 'dark', matchSystemTheme: false });
    expect(await host.settings.update({ matchSystemTheme: true })).toMatchObject({
      appearanceMode: 'system',
      matchSystemTheme: true,
    });
    expect(await host.settings.update({ appearanceMode: 'light' })).toMatchObject({
      appearanceMode: 'light',
      matchSystemTheme: false,
    });
  });
});
