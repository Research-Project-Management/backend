/**
 * spelling/types/spelling.types.ts
 * Domain and service type contracts for the Pages Spelling subsystem.
 */

export type SupportedLanguage =
  | 'en'
  | 'en-us'
  | 'en-ca'
  | 'en-gb'
  | 'vi'
  | 'vi-vn'
  | 'fr'
  | 'fr-fr'
  | 'de'
  | 'de-de'
  | 'es'
  | 'es-es';

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
