/**
 * spelling/types/spelling.types.ts
 * Single source of truth for supported languages and pure domain/service contracts.
 */

export const DICTIONARY_PACKAGES = {
  en: 'dictionary-en',
  'en-US': 'dictionary-en',
  'en-CA': 'dictionary-en',
  'en-GB': 'dictionary-en-gb',
  vi: 'dictionary-vi',
  'vi-VN': 'dictionary-vi',
  fr: 'dictionary-fr',
  'fr-FR': 'dictionary-fr',
  de: 'dictionary-de',
  'de-DE': 'dictionary-de',
  es: 'dictionary-es',
  'es-ES': 'dictionary-es',
} as const;

export type SupportedLanguage = keyof typeof DICTIONARY_PACKAGES;

export type SpellingLanguage = SupportedLanguage | 'off';

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
  language: SpellingLanguage;
  totalWordsChecked: number;
  misspelledCount: number;
  errors: MisspelledWord[];
}

export interface CustomDictionaryResult {
  words: string[];
  count: number;
}
