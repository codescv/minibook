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
  const tag = (raw ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')).toLowerCase();
  if (tag.startsWith('zh')) return 'zh-CN';
  if (tag.startsWith('ja')) return 'ja';
  return 'en';
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

export function useT(locale?: SupportedLocale) {
  const active = locale ?? resolveLocale(typeof document !== 'undefined' ? document.documentElement.lang : 'en');
  return (key: I18nKey, vars?: Readonly<Record<string, string | number>>) => translate(active, key, vars);
}

export { en, zhCN, ja, type I18nKey, type I18nDict };
