/**
 * spelling/types/spelling.types.ts
 * Single source of truth for supported languages and pure domain/service contracts.
 */

export const DICTIONARY_PACKAGES = {
  en: 'dictionary-en',
  'en-us': 'dictionary-en',
  'en-ca': 'dictionary-en',
  'en-gb': 'dictionary-en-gb',
  vi: 'dictionary-vi',
  'vi-vn': 'dictionary-vi',
  fr: 'dictionary-fr',
  'fr-fr': 'dictionary-fr',
  de: 'dictionary-de',
  'de-de': 'dictionary-de',
  es: 'dictionary-es',
  'es-es': 'dictionary-es',
} as const;

export type SupportedLanguage = keyof typeof DICTIONARY_PACKAGES;

export const SUPPORTED_LANGUAGES = Object.keys(
  DICTIONARY_PACKAGES,
) as SupportedLanguage[];

export interface CheckSpellingInput {
  words: readonly string[];
  language?: string;
}

export interface MisspelledWord {
  word: string;
  suggestions: string[];
}

export interface SpellingReport {
  language: SupportedLanguage;
  totalWordsChecked: number;
  misspelledCount: number;
  errors: MisspelledWord[];
}

export interface CustomDictionaryResult {
  words: string[];
  count: number;
}
