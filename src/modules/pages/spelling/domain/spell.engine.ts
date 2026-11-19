/**
 * modules/pages/spelling/domain/spell.engine.ts
 * Pure domain SpellEngine orchestrating dictionaries, tokenization, and suggestions.
 * Zero I/O, zero NestJS imports.
 */

import { InvalidWordException } from './spelling.errors';
import {
  SHARED_DICTIONARY_WORDS,
  ENGLISH_WORDS,
  VIETNAMESE_WORDS,
  FRENCH_WORDS,
  GERMAN_WORDS,
  SPANISH_WORDS,
} from './dictionaries';
import {
  LanguageCodeVo,
  WordTokenVo,
  WordToken,
  MisspelledWord,
  SpellingReport,
  LanguageProfileRegistry,
  LanguageSpellProfileRegistry,
  type WordTokenProps,
  type MisspelledWordProps,
  type SpellingReportProps,
  type LanguageMorphologyProfile,
} from './spelling.models';
import { LatexTokenizer, LatexProseTokenizer } from './latex.tokenizer';
import {
  getMorphologicalStems,
  getRomanceGermanicStems,
  levenshteinDamerau,
} from './morphology-stemmer';

export {
  LanguageCodeVo,
  WordTokenVo,
  MisspelledWord,
  SpellingReport,
  LanguageProfileRegistry,
  LanguageSpellProfileRegistry,
  LatexTokenizer,
  LatexProseTokenizer,
};
export type {
  WordTokenProps,
  WordToken,
  MisspelledWordProps,
  SpellingReportProps,
  LanguageMorphologyProfile,
};

export class SpellEngine {
  private readonly englishDictionary: Set<string>;
  private readonly vietnameseDictionary: Set<string>;
  private readonly frenchDictionary: Set<string>;
  private readonly germanDictionary: Set<string>;
  private readonly spanishDictionary: Set<string>;
  private readonly profileRegistry = new LanguageProfileRegistry();
  private readonly lengthBuckets = new Map<
    Set<string>,
    Map<number, string[]>
  >();
  private readonly tokenizer: LatexTokenizer;

  constructor(tokenizer?: LatexTokenizer) {
    this.englishDictionary = new Set<string>();
    this.vietnameseDictionary = new Set<string>();
    this.frenchDictionary = new Set<string>();
    this.germanDictionary = new Set<string>();
    this.spanishDictionary = new Set<string>();
    this.tokenizer = tokenizer ?? new LatexTokenizer();
    this.seedDictionaries();
    this.initLanguageProfiles();
  }

  private initLanguageProfiles(): void {
    this.profileRegistry
      .register(
        {
          baseLanguage: 'en',
          dictionary: this.englishDictionary,
          getStems: (word) => getMorphologicalStems(word),
        },
        true,
      )
      .register({
        baseLanguage: 'vi',
        dictionary: this.vietnameseDictionary,
        getStems: () => [],
      })
      .register({
        baseLanguage: 'fr',
        dictionary: this.frenchDictionary,
        getStems: (word) => getRomanceGermanicStems(word, 'fr'),
      })
      .register({
        baseLanguage: 'de',
        dictionary: this.germanDictionary,
        getStems: (word) => getRomanceGermanicStems(word, 'de'),
      })
      .register({
        baseLanguage: 'es',
        dictionary: this.spanishDictionary,
        getStems: (word) => getRomanceGermanicStems(word, 'es'),
      });
  }

  public static validateCustomWord(raw: string): string {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length < 2) {
      throw new InvalidWordException(
        raw,
        'Learned word must be at least 2 characters long.',
      );
    }
    if (trimmed.length > 64) {
      throw new InvalidWordException(
        raw,
        'Learned word cannot exceed 64 characters.',
      );
    }
    if (/\s/.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word must be a single token without whitespace.',
      );
    }
    if (!/^[\p{L}\p{M}'’-]+$/u.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word may only contain letters, hyphens, or apostrophes.',
      );
    }
    return trimmed.toLowerCase();
  }

  public checkText(
    rawText: string,
    language?: string,
    customWords: Iterable<string> = [],
    maxSuggestions = 5,
    tokenizerOverride?: LatexTokenizer,
  ): SpellingReport {
    const langVo = LanguageCodeVo.create(language);

    if (!rawText || !rawText.trim()) {
      return new SpellingReport({
        language: langVo.code,
        totalWordsChecked: 0,
        errors: [],
      });
    }

    const activeTokenizer = tokenizerOverride ?? this.tokenizer;
    const tokens = activeTokenizer.tokenize(rawText);
    const customSet = new Set<string>();
    for (const w of customWords) {
      customSet.add(w.toLowerCase());
    }

    const errors: MisspelledWord[] = [];
    const suggestionsCache = new Map<string, string[]>();

    for (const token of tokens) {
      const lower = token.normalized;
      if (customSet.has(lower)) {
        continue;
      }
      if (this.isCorrect(token.word, langVo) || this.isCorrect(lower, langVo)) {
        continue;
      }

      let suggestions = suggestionsCache.get(lower);
      if (!suggestions) {
        suggestions = this.getSuggestions(token.word, langVo, maxSuggestions);
        suggestionsCache.set(lower, suggestions);
      }

      errors.push(
        new MisspelledWord({
          word: token.word,
          line: token.line,
          col: token.col,
          length: token.length,
          suggestions,
        }),
      );
    }

    return new SpellingReport({
      language: langVo.code,
      totalWordsChecked: tokens.length,
      errors,
    });
  }

  private getDictionaryForLanguage(language: LanguageCodeVo): Set<string> {
    return this.profileRegistry.resolve(language.baseLanguage).dictionary;
  }

  public isCorrect(word: string, language: LanguageCodeVo): boolean {
    const clean = word.toLowerCase().trim().normalize('NFC');
    if (!clean) return true;

    if (/^\d+$/.test(clean) || clean.length === 1) return true;

    const profile = this.profileRegistry.resolve(language.baseLanguage);
    const dict = profile.dictionary;
    if (dict.has(clean)) return true;

    if (clean.includes('-') || clean.includes("'") || clean.includes('’')) {
      const parts = clean.split(/[-'’]/);
      if (
        parts.length > 1 &&
        parts.every((p) => !p || this.isCorrect(p, language))
      ) {
        return true;
      }
    }

    const stems = profile.getStems(clean);
    for (const stem of stems) {
      if (dict.has(stem)) {
        return true;
      }
    }

    return false;
  }

  public getSuggestions(
    word: string,
    language: LanguageCodeVo,
    maxSuggestions = 5,
  ): string[] {
    const clean = word.toLowerCase().trim().normalize('NFC');
    if (!clean) return [];

    if (this.isCorrect(word, language)) {
      return [];
    }

    const isCapitalized = /^[A-ZÀ-ÖØ-Þ]/.test(word);
    const isAllUpper = /^[A-ZÀ-ÖØ-Þ]+$/.test(word) && word.length > 1;

    interface Candidate {
      word: string;
      dist: number;
    }

    const candidates: Candidate[] = [];
    const dict = this.getDictionaryForLanguage(language);
    const buckets = this.lengthBuckets.get(dict);

    if (buckets) {
      const minLen = Math.max(1, clean.length - 2);
      const maxLen = clean.length + 2;
      for (let len = minLen; len <= maxLen; len++) {
        const bucket = buckets.get(len);
        if (!bucket) continue;
        for (const dictWord of bucket) {
          const dist = levenshteinDamerau(clean, dictWord);
          if (dist <= 2) {
            candidates.push({ word: dictWord, dist });
          }
        }
      }
    } else {
      for (const dictWord of dict) {
        if (Math.abs(dictWord.length - clean.length) > 2) {
          continue;
        }

        const dist = levenshteinDamerau(clean, dictWord);
        if (dist <= 2) {
          candidates.push({ word: dictWord, dist });
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      const lenDiffA = Math.abs(a.word.length - clean.length);
      const lenDiffB = Math.abs(b.word.length - clean.length);
      if (lenDiffA !== lenDiffB) return lenDiffA - lenDiffB;
      return a.word.localeCompare(b.word);
    });

    return candidates.slice(0, maxSuggestions).map((c) => {
      if (isAllUpper) return c.word.toUpperCase();
      if (isCapitalized)
        return c.word.charAt(0).toUpperCase() + c.word.slice(1);
      return c.word;
    });
  }

  public getSupportedLanguages(): string[] {
    return [
      'en',
      'en-US',
      'en-GB',
      'en-CA',
      'vi',
      'vi-VN',
      'fr',
      'fr-FR',
      'de',
      'de-DE',
      'es',
      'es-ES',
    ];
  }

  private seedDictionaries(): void {
    for (const w of SHARED_DICTIONARY_WORDS) {
      const lower = w.toLowerCase();
      this.englishDictionary.add(lower);
      this.vietnameseDictionary.add(lower);
      this.frenchDictionary.add(lower);
      this.germanDictionary.add(lower);
      this.spanishDictionary.add(lower);
    }

    for (const w of ENGLISH_WORDS) {
      this.englishDictionary.add(w.toLowerCase());
    }

    for (const w of VIETNAMESE_WORDS) {
      this.vietnameseDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of FRENCH_WORDS) {
      this.frenchDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of GERMAN_WORDS) {
      this.germanDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of SPANISH_WORDS) {
      this.spanishDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const dict of [
      this.englishDictionary,
      this.vietnameseDictionary,
      this.frenchDictionary,
      this.germanDictionary,
      this.spanishDictionary,
    ]) {
      const bucketMap = new Map<number, string[]>();
      for (const word of dict) {
        const len = word.length;
        let list = bucketMap.get(len);
        if (!list) {
          list = [];
          bucketMap.set(len, list);
        }
        list.push(word);
      }
      this.lengthBuckets.set(dict, bucketMap);
    }
  }
}

export { SpellEngine as AcademicSpellEngine };
