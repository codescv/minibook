import { DEFAULT_APP_SETTINGS, sanitizeAppSettings, type AppSettings } from '@minibook/core';
import type { Database } from '../sqlite.js';

const APP_SETTINGS_KEY = 'app';

export class SettingsRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get(): AppSettings {
    const row = this.db
      .prepare('SELECT json FROM settings WHERE key = ?')
      .get(APP_SETTINGS_KEY) as { readonly json: string } | undefined;
    if (!row) {
      return DEFAULT_APP_SETTINGS;
    }
    try {
      const parsed = JSON.parse(row.json) as Partial<AppSettings>;
      return mergeSettings(DEFAULT_APP_SETTINGS, parsed);
    } catch {
      return DEFAULT_APP_SETTINGS;
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = mergeSettings(this.get(), patch);
    this.db
      .prepare(
        `INSERT INTO settings (key, json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET json = excluded.json`,
      )
      .run(APP_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
}

export function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return sanitizeAppSettings(patch, base);
}
