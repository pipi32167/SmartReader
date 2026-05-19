export type TranslationMap = Record<string, string>;

export type SupportedLocale = 'zh-CN' | 'en';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['zh-CN', 'en'];

export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';

export const LOCALE_STORAGE_KEY = 'smartreader_locale';
