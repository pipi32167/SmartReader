import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  t,
  setLocaleSync,
  getLocaleSync,
  detectBrowserLocale,
  initTranslations,
} from './index';

describe('i18n', () => {
  beforeEach(() => {
    // Reset to zh-CN before each test
    setLocaleSync('zh-CN');
  });

  describe('t()', () => {
    it('returns Chinese translation when locale is zh-CN', () => {
      expect(t('popup.title')).toBe('SmartReader');
      expect(t('popup.btn.send')).toBe('🚀 发送');
    });

    it('returns English translation when locale is en', () => {
      setLocaleSync('en');
      expect(t('popup.title')).toBe('SmartReader');
      expect(t('popup.btn.send')).toBe('🚀 Send');
    });

    it('falls back to zh-CN when key is missing in current locale', () => {
      setLocaleSync('en');
      // Assume 'sidepanel.error.someNewError' only exists in zh-CN
      expect(t('sidepanel.error.someNewError')).toBe('新错误（中文回退）');
    });

    it('returns the key itself when key is missing in all locales', () => {
      expect(t('nonexistent.key.123')).toBe('nonexistent.key.123');
    });

    it('interpolates parameters correctly', () => {
      expect(t('popup.error.generic', { message: 'network timeout' })).toBe(
        '操作失败: network timeout'
      );
    });

    it('leaves placeholder unchanged when param is missing', () => {
      expect(t('popup.error.generic')).toBe('操作失败: {{message}}');
    });
  });

  describe('detectBrowserLocale()', () => {
    it('maps zh-CN to zh-CN', () => {
      expect(detectBrowserLocale('zh-CN')).toBe('zh-CN');
    });

    it('maps zh to zh-CN', () => {
      expect(detectBrowserLocale('zh')).toBe('zh-CN');
    });

    it('maps zh-TW to zh-CN', () => {
      expect(detectBrowserLocale('zh-TW')).toBe('zh-CN');
    });

    it('maps en-US to en', () => {
      expect(detectBrowserLocale('en-US')).toBe('en');
    });

    it('maps en to en', () => {
      expect(detectBrowserLocale('en')).toBe('en');
    });

    it('maps unsupported language to en', () => {
      expect(detectBrowserLocale('fr-FR')).toBe('en');
      expect(detectBrowserLocale('ja-JP')).toBe('en');
    });
  });

  describe('locale getter/setter', () => {
    it('getLocaleSync returns current locale', () => {
      setLocaleSync('en');
      expect(getLocaleSync()).toBe('en');
      setLocaleSync('zh-CN');
      expect(getLocaleSync()).toBe('zh-CN');
    });
  });

  describe('initTranslations', () => {
    it('loads locale from storage when available', async () => {
      const mockStorage = {
        smartreader_locale: 'en',
      };
      global.chrome = {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue(mockStorage),
          },
        },
      } as any;

      await initTranslations();
      expect(getLocaleSync()).toBe('en');
    });

    it('falls back to browser locale when storage is empty', async () => {
      global.chrome = {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({}),
          },
        },
        i18n: {
          getUILanguage: vi.fn().mockReturnValue('en-US'),
        },
      } as any;

      await initTranslations();
      expect(getLocaleSync()).toBe('en');
    });
  });
});
