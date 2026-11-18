/**
 * Lightweight adaptive EN / ZH internationalization helper.
 *
 * Resolution priority:
 * 1. Explicit URL parameter (`?lang=en` or `?lang=zh`)
 * 2. User preference saved in `settings.json` (`lang: 'zh' | 'en'`)
 * 3. Host / browser locale (`navigator.languages` / `navigator.language`, `'zh*'` -> `'zh'`, else `'en'`)
 */

import { state } from './state.js';

export const LANG_OPTIONS = [
  { id: 'auto', zh: '跟随系统', en: 'Auto' },
  { id: 'zh', zh: '中文', en: '中文' },
  { id: 'en', zh: 'English', en: 'English' },
];

export function detectSystemLang() {
  try {
    const list =
      Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language || ''];
    for (const raw of list) {
      const tag = String(raw || '').trim().toLowerCase();
      if (!tag) continue;
      return tag.startsWith('zh') ? 'zh' : 'en';
    }
  } catch {
    // Fallback to English outside browser environments
  }
  return 'en';
}

export function resolveLang() {
  if (state.urlLang === 'zh' || state.urlLang === 'en') {
    return state.urlLang;
  }
  const pref = state.settings?.lang;
  if (pref === 'zh' || pref === 'en') {
    return pref;
  }
  return detectSystemLang();
}

export function isEn() {
  return resolveLang() === 'en';
}

export function tr(zh, en) {
  return resolveLang() === 'en' ? en : zh;
}

export function syncDocumentLang() {
  const lang = resolveLang();
  const htmlLang = lang === 'en' ? 'en' : 'zh-CN';
  if (typeof document !== 'undefined' && document.documentElement.lang !== htmlLang) {
    document.documentElement.lang = htmlLang;
  }
  return lang;
}
