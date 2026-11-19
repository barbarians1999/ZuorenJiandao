// Chinese-only interface. Keep the preference key so existing installs migrate cleanly.
import { localeDicts } from './dictRegistry';

export { ensureLocaleDict } from './dictRegistry';
export type Locale = 'zh';

const STORAGE_KEY = 'cc.locale';
const current: Locale = 'zh';
try {
  if (localStorage.getItem(STORAGE_KEY) !== current) localStorage.setItem(STORAGE_KEY, current);
} catch { /* Browser storage may be unavailable. */ }
if (typeof document !== 'undefined') document.documentElement.lang = 'zh-CN';

export function getLocale(): Locale {
  return current;
}

export function localeLanguageName(_locale: Locale = current): '中文' {
  return '中文';
}

export function localizedCatalogText(_english: string, chinese: string, _locale: Locale = current): string {
  return chinese;
}

/** Chinese source strings are the interface copy and need no translation table. */
export function t(zh: string, params?: Record<string, string | number>): string {
  if (!params) return zh;
  return zh.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

/** Translate legacy built-in catalog names for display without changing project data. */
export function tData(text: string): string {
  const { data, dataFallback } = localeDicts(current);
  return data[text] ?? dataFallback[text] ?? text;
}

export function useT(): typeof t {
  return t;
}
