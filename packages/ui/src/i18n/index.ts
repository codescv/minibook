import { useCallback, useEffect } from 'react';
import type { UiLanguage } from '@minibook/core';
import { useSettingsStore } from '../host/settings-store';
import { en, type I18nDict, type I18nKey } from './en';
import { zhCN } from './zh-CN';
import { ja } from './ja';

export type SupportedLocale = 'en' | 'zh-CN' | 'ja';

const DICTS: Record<SupportedLocale, I18nDict> = {
  en,
  'zh-CN': zhCN,
  ja,
};

export function resolveLocale(raw?: string | null): SupportedLocale {
  const trimmed = raw?.trim();
  const effectiveRaw =
    trimmed && trimmed.length > 0 && trimmed.toLowerCase() !== 'system' ? trimmed : undefined;
  const tag = (
    effectiveRaw ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')
  ).toLowerCase();
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  return 'en';
}

export function resolveActiveLocale(uiLanguage?: UiLanguage | null): SupportedLocale {
  const setting = uiLanguage ?? useSettingsStore.getState().settings.uiLanguage;
  if (setting === 'zh-CN' || setting === 'en' || setting === 'ja') {
    return setting;
  }
  return resolveLocale();
}

export function localeToHtmlLang(locale: SupportedLocale): string {
  if (locale === 'zh-CN') return 'zh-Hans';
  if (locale === 'ja') return 'ja';
  return 'en';
}

export function syncDocumentLang(preferred?: SupportedLocale, preserveExplicitNonDefault = false): string {
  const existing = typeof document !== 'undefined' ? document.documentElement.lang?.trim() : '';
  const resolved =
    preferred ??
    (preserveExplicitNonDefault && existing && existing.toLowerCase() !== 'en'
      ? resolveLocale(existing)
      : resolveLocale());
  const htmlLang = localeToHtmlLang(resolved);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = htmlLang;
  }
  return htmlLang;
}

export function translate(
  locale: SupportedLocale,
  key: I18nKey,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const template = DICTS[locale][key] ?? en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

export function useLocale(locale?: SupportedLocale): SupportedLocale {
  const uiLanguage = useSettingsStore((s) => s.settings.uiLanguage);
  const active = locale ?? resolveActiveLocale(uiLanguage);
  useEffect(() => {
    syncDocumentLang(active);
  }, [active]);
  return active;
}

export function useT(locale?: SupportedLocale) {
  const active = useLocale(locale);
  return useCallback(
    (key: I18nKey, vars?: Readonly<Record<string, string | number>>) => translate(active, key, vars),
    [active],
  );
}

export { en, zhCN, ja, type I18nKey, type I18nDict };
