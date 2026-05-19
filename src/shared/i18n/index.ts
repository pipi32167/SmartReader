import type { SupportedLocale } from './types';
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY } from './types';
import { zhCN } from './locales/zh-CN';
import { en } from './locales/en';

const translations: Record<SupportedLocale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en': en,
};

let currentLocale: SupportedLocale = DEFAULT_LOCALE;

function normalizeLocale(locale: string): SupportedLocale {
  if (locale === 'zh-CN' || locale.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export function t(key: string, params?: Record<string, string | number>): string {
  let text = translations[currentLocale][key];
  if (text === undefined) {
    text = translations[DEFAULT_LOCALE][key];
  }
  if (text === undefined) {
    return key;
  }
  if (params) {
    return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      const value = params[name];
      return value !== undefined ? String(value) : `{{${name}}}`;
    });
  }
  return text;
}

export function setLocaleSync(locale: string): void {
  currentLocale = normalizeLocale(locale);
}

export function getLocaleSync(): string {
  return currentLocale;
}

export async function setLocale(locale: string): Promise<void> {
  const normalized = normalizeLocale(locale);
  currentLocale = normalized;
  try {
    await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: normalized });
  } catch {
    // ignore storage errors
  }
}

export async function getCurrentLocale(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(LOCALE_STORAGE_KEY);
    if (result[LOCALE_STORAGE_KEY]) {
      return normalizeLocale(result[LOCALE_STORAGE_KEY]);
    }
  } catch {
    // ignore
  }
  return detectBrowserLocale(navigator.language);
}

export function detectBrowserLocale(lang: string): SupportedLocale {
  if (lang.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export async function initTranslations(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(LOCALE_STORAGE_KEY);
    if (result[LOCALE_STORAGE_KEY]) {
      currentLocale = normalizeLocale(result[LOCALE_STORAGE_KEY]);
      return;
    }
  } catch {
    // ignore
  }

  let browserLang: string;
  try {
    browserLang = (chrome as any).i18n?.getUILanguage?.() || navigator.language;
  } catch {
    browserLang = navigator.language;
  }
  currentLocale = detectBrowserLocale(browserLang);
}

export function initPage(root?: HTMLElement): void {
  const container = root || document.body;
  if (!container) return;

  // Set html lang attribute
  if (document.documentElement) {
    document.documentElement.lang = currentLocale === 'zh-CN' ? 'zh-CN' : 'en';
  }

  // Translate text content
  container.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (key) {
      el.textContent = t(key);
    }
  });

  // Translate attributes
  const attrMap: Record<string, string> = {
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-title': 'title',
  };

  for (const [dataAttr, realAttr] of Object.entries(attrMap)) {
    container.querySelectorAll<HTMLElement>(`[${dataAttr}]`).forEach(el => {
      const key = el.getAttribute(dataAttr);
      if (key) {
        el.setAttribute(realAttr, t(key));
      }
    });
  }
}
