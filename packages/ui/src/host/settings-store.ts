import { create } from 'zustand';
import {
  DEFAULT_APP_SETTINGS,
  sanitizeAppSettings,
  type AppSettings,
} from '@minibook/core';

export interface SettingsStoreState {
  settings: AppSettings;
  hydrated: boolean;
  setSettings(next: AppSettings): void;
  patchLocal(patch: Partial<AppSettings>): void;
  reset(): void;
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: DEFAULT_APP_SETTINGS,
  hydrated: false,
  setSettings(next) {
    set({ settings: sanitizeAppSettings(next, DEFAULT_APP_SETTINGS), hydrated: true });
  },
  patchLocal(patch) {
    set((s) => ({ settings: sanitizeAppSettings(patch, s.settings) }));
  },
  reset() {
    set({ settings: DEFAULT_APP_SETTINGS, hydrated: false });
  },
}));
