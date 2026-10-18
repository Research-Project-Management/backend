/**
 * spelling/domain/spelling.ports.ts
 * Outbound SPI Ports for spelling tokenization, spell engine, and custom dictionary storage.
 */

import { WordTokenVo } from './word-token.vo';
import { LanguageCodeVo } from './language-code.vo';

export const LATEX_TOKENIZER_PORT = Symbol('LATEX_TOKENIZER_PORT');

export interface ILatexTokenizerPort {
  /**
   * Tokenizes LaTeX source text, stripping commands, math environments, and comments,
   * while preserving exact line and column coordinates for every prose word.
   */
  tokenize(text: string): WordTokenVo[];
}

export const SPELL_ENGINE_PORT = Symbol('SPELL_ENGINE_PORT');

export interface ISpellEnginePort {
  /**
   * Checks whether a given word exists and is spelled correctly in the specified language.
   */
  isCorrect(word: string, language: LanguageCodeVo): boolean;

  /**
   * Generates a ranked list of candidate suggestions for a misspelled word.
   */
  getSuggestions(
    word: string,
    language: LanguageCodeVo,
    maxSuggestions?: number,
  ): string[];

  /**
   * Returns list of supported language codes.
   */
  getSupportedLanguages(): string[];
}

export const CUSTOM_DICTIONARY_REPOSITORY_PORT = Symbol(
  'CUSTOM_DICTIONARY_REPOSITORY_PORT',
);

export interface ICustomDictionaryRepositoryPort {
  listProjectWords(projectId: string): Promise<string[]>;
  listUserWords(userId: string): Promise<string[]>;
  addProjectWord(projectId: string, word: string): Promise<void>;
  addUserWord(userId: string, word: string): Promise<void>;
  removeProjectWord(projectId: string, word: string): Promise<boolean>;
  removeUserWord(userId: string, word: string): Promise<boolean>;
  isCustomWord(
    word: string,
    projectId?: string,
    userId?: string,
  ): Promise<boolean>;
}
