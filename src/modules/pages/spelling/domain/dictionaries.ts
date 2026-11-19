/**
 * modules/pages/spelling/domain/dictionaries.ts
 * Pure domain vocabulary lists for academic, LaTeX, scientific, and multi-language spell checking.
 * Zero I/O, zero NestJS imports.
 */

export {
  ENGLISH_WORDS,
  ENGLISH_COMMON_WORDS,
} from './dictionaries/english.dictionary';
export {
  VIETNAMESE_WORDS,
  VIETNAMESE_COMMON_WORDS,
} from './dictionaries/vietnamese.dictionary';
export {
  SHARED_DICTIONARY_WORDS,
  ACADEMIC_SHARED_WORDS,
  ACADEMIC_DICTIONARY_WORDS,
} from './dictionaries/shared-academic.dictionary';
export {
  FRENCH_WORDS,
  FRENCH_ACADEMIC_WORDS,
} from './dictionaries/french.dictionary';
export {
  GERMAN_WORDS,
  GERMAN_ACADEMIC_WORDS,
} from './dictionaries/german.dictionary';
export {
  SPANISH_WORDS,
  SPANISH_ACADEMIC_WORDS,
} from './dictionaries/spanish.dictionary';
