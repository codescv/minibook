import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  resolveAppearanceSettings,
  sanitizeAppSettings,
  type AppSettings,
} from '../index.js';

describe('Apple Books Appearance (Light / Dark / Match System) settings', () => {
  it('defaults to Match System with the legacy mirror in sync', () => {
    expect(DEFAULT_APP_SETTINGS.appearanceMode).toBe('system');
    expect(DEFAULT_APP_SETTINGS.matchSystemTheme).toBe(true);
    const s = sanitizeAppSettings(undefined);
    expect(s.appearanceMode).toBe('system');
    expect(s.matchSystemTheme).toBe(true);
    const empty = sanitizeAppSettings({});
    expect(empty.appearanceMode).toBe('system');
    expect(empty.matchSystemTheme).toBe(true);
  });

  it('honours an explicit appearanceMode and syncs matchSystemTheme', () => {
    for (const mode of ['system', 'light', 'dark'] as const) {
      const s = sanitizeAppSettings({ theme: 'calm', appearanceMode: mode });
      expect(s.appearanceMode).toBe(mode);
      expect(s.matchSystemTheme).toBe(mode === 'system');
      expect(s.theme).toBe('calm');
    }
    // appearanceMode wins over a conflicting legacy flag
    const conflict = sanitizeAppSettings({ appearanceMode: 'dark', matchSystemTheme: true });
    expect(conflict.appearanceMode).toBe('dark');
    expect(conflict.matchSystemTheme).toBe(false);
  });

  it('migrates legacy persisted matchSystemTheme payloads', () => {
    expect(sanitizeAppSettings({ theme: 'paper', matchSystemTheme: true })).toMatchObject({
      theme: 'paper',
      appearanceMode: 'system',
      matchSystemTheme: true,
    });
    expect(sanitizeAppSettings({ theme: 'quiet', matchSystemTheme: false })).toMatchObject({
      theme: 'quiet',
      appearanceMode: 'dark',
      matchSystemTheme: false,
    });
    for (const theme of ['original', 'paper', 'calm'] as const) {
      expect(sanitizeAppSettings({ theme, matchSystemTheme: false })).toMatchObject({
        theme,
        appearanceMode: 'light',
        matchSystemTheme: false,
      });
    }
  });

  it('ignores malformed appearanceMode values', () => {
    const s = sanitizeAppSettings({ appearanceMode: 'sepia', matchSystemTheme: 'yes' });
    expect(s.appearanceMode).toBe('system');
    expect(s.matchSystemTheme).toBe(true);
  });

  it('keeps patches consistent when merged over a base (host update path)', () => {
    const darkBase: AppSettings = sanitizeAppSettings({ theme: 'calm', appearanceMode: 'dark' });

    // Theme-only patch keeps the Appearance untouched (orthogonal axes)
    const themed = sanitizeAppSettings({ theme: 'paper' }, darkBase);
    expect(themed).toMatchObject({ theme: 'paper', appearanceMode: 'dark', matchSystemTheme: false });

    // Legacy `{ matchSystemTheme: true }` -> system
    const sys = sanitizeAppSettings({ matchSystemTheme: true }, darkBase);
    expect(sys).toMatchObject({ theme: 'calm', appearanceMode: 'system', matchSystemTheme: true });

    // Legacy `{ matchSystemTheme: false }` keeps an explicit Light/Dark choice of the base
    const keep = sanitizeAppSettings({ matchSystemTheme: false }, darkBase);
    expect(keep).toMatchObject({ appearanceMode: 'dark', matchSystemTheme: false });

    // ... and derives from the theme when the base was following the system
    const sysBase = sanitizeAppSettings({ theme: 'quiet', appearanceMode: 'system' });
    expect(sanitizeAppSettings({ matchSystemTheme: false }, sysBase)).toMatchObject({
      appearanceMode: 'dark',
      matchSystemTheme: false,
    });
    expect(sanitizeAppSettings({ matchSystemTheme: false, theme: 'paper' }, sysBase)).toMatchObject({
      appearanceMode: 'light',
      matchSystemTheme: false,
    });

    // New-style patch
    expect(sanitizeAppSettings({ appearanceMode: 'light' }, darkBase)).toMatchObject({
      theme: 'calm',
      appearanceMode: 'light',
      matchSystemTheme: false,
    });
  });

  it('resolveAppearanceSettings repairs inconsistent / legacy bases', () => {
    const legacyBase = { matchSystemTheme: false } as unknown as Pick<
      AppSettings,
      'appearanceMode' | 'matchSystemTheme'
    >;
    expect(resolveAppearanceSettings({}, legacyBase, 'quiet')).toEqual({
      appearanceMode: 'dark',
      matchSystemTheme: false,
    });
    expect(resolveAppearanceSettings({}, legacyBase, 'original')).toEqual({
      appearanceMode: 'light',
      matchSystemTheme: false,
    });
    expect(
      resolveAppearanceSettings({}, { appearanceMode: 'light', matchSystemTheme: true }, 'calm'),
    ).toEqual({ appearanceMode: 'light', matchSystemTheme: false });
  });
});
