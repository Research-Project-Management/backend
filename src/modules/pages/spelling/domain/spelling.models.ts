/**
 * modules/pages/spelling/domain/spelling.models.ts
 * Pure domain value objects, entities, and language profile registry for spell checking.
 * Zero I/O, zero NestJS imports.
 */

import {
  InvalidWordException,
  UnsupportedLanguageException,
} from './spelling.errors';

export class LanguageCodeVo {
  private static readonly SUPPORTED_CODES = new Set([
    'en',
    'en-us',
    'en-gb',
    'en-ca',
    'vi',
    'vi-vn',
    'fr',
    'fr-fr',
    'de',
    'de-de',
    'es',
    'es-es',
  ]);

  public readonly code: string;
  public readonly baseLanguage: string;

  private constructor(normalizedCode: string) {
    this.code = normalizedCode;
    this.baseLanguage = normalizedCode.split('-')[0] || normalizedCode;
  }

  public static create(raw?: string): LanguageCodeVo {
    if (!raw || raw.trim() === '') {
      return new LanguageCodeVo('en-us');
    }

    const normalized = raw.trim().toLowerCase().replace('_', '-');
    if (!LanguageCodeVo.SUPPORTED_CODES.has(normalized)) {
      throw new UnsupportedLanguageException(raw);
    }

    return new LanguageCodeVo(normalized);
  }

  public isEnglish(): boolean {
    return this.baseLanguage === 'en';
  }

  public equals(other: LanguageCodeVo): boolean {
    return this.code === other.code;
  }

  public toString(): string {
    return this.code;
  }
}

export interface WordTokenProps {
  word: string;
  line: number;
  col: number;
  length?: number;
}

export class WordTokenVo {
  public readonly word: string;
  public readonly normalized: string;
  public readonly line: number;
  public readonly col: number;
  public readonly length: number;

  constructor(props: WordTokenProps) {
    if (!props.word || props.word.trim() === '') {
      throw new InvalidWordException(props.word, 'Word token cannot be empty');
    }

    this.word = props.word;
    this.normalized = props.word.toLowerCase();
    this.line = Math.max(1, props.line);
    this.col = Math.max(1, props.col);
    this.length = props.length || props.word.length;
  }

  public toJSON() {
    return {
      word: this.word,
      line: this.line,
      col: this.col,
      length: this.length,
    };
  }
}

export type WordToken = WordTokenVo;

export interface MisspelledWordProps {
  word: string;
  line: number;
  col: number;
  length: number;
  suggestions?: string[];
}

export class MisspelledWord {
  public readonly word: string;
  public readonly line: number;
  public readonly col: number;
  public readonly length: number;
  public readonly suggestions: readonly string[];

  constructor(props: MisspelledWordProps) {
    this.word = props.word;
    this.line = props.line;
    this.col = props.col;
    this.length = props.length;
    this.suggestions = Object.freeze(
      props.suggestions ? [...props.suggestions] : [],
    );
  }

  public toJSON() {
    return {
      word: this.word,
      line: this.line,
      col: this.col,
      length: this.length,
      suggestions: [...this.suggestions],
    };
  }
}

export interface SpellingReportProps {
  language: string;
  totalWordsChecked: number;
  errors: MisspelledWord[];
}

export class SpellingReport {
  public readonly language: string;
  public readonly totalWordsChecked: number;
  public readonly misspelledCount: number;
  public readonly errors: readonly MisspelledWord[];

  constructor(props: SpellingReportProps) {
    this.language = props.language;
    this.totalWordsChecked = props.totalWordsChecked;
    this.errors = Object.freeze([...props.errors]);
    this.misspelledCount = this.errors.length;
  }

  public toJSON() {
    return {
      language: this.language,
      totalWordsChecked: this.totalWordsChecked,
      misspelledCount: this.misspelledCount,
      errors: this.errors.map((e) => e.toJSON()),
    };
  }
}

export interface LanguageMorphologyProfile {
  readonly baseLanguage: string;
  readonly dictionary: Set<string>;
  getStems(word: string): string[];
}

export class LanguageProfileRegistry {
  private readonly profiles = new Map<string, LanguageMorphologyProfile>();
  private fallbackProfile!: LanguageMorphologyProfile;

  public register(
    profile: LanguageMorphologyProfile,
    isFallback = false,
  ): this {
    this.profiles.set(profile.baseLanguage.toLowerCase(), profile);
    if (isFallback || !this.fallbackProfile) {
      this.fallbackProfile = profile;
    }
    return this;
  }

  public resolve(baseLanguage: string): LanguageMorphologyProfile {
    return (
      this.profiles.get(baseLanguage.toLowerCase()) ?? this.fallbackProfile
    );
  }
}

export { LanguageProfileRegistry as LanguageSpellProfileRegistry };
