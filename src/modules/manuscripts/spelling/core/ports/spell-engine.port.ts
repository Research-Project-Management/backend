/**
 * spelling/core/ports/spell-engine.port.ts
 * Outbound SPI Port for checking word correctness and generating spelling suggestions.
 */

import { LanguageCodeVo } from '../domain/value-objects/language-code.vo';

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
    maxSuggestions?: number
  ): string[];

  /**
   * Returns list of supported language codes.
   */
  getSupportedLanguages(): string[];
}
