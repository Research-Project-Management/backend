/**
 * spelling/core/ports/latex-tokenizer.port.ts
 * Outbound SPI Port for tokenizing LaTeX source text into natural prose word tokens.
 */

import { WordTokenVo } from '../domain/value-objects/word-token.vo';

export const LATEX_TOKENIZER_PORT = Symbol('LATEX_TOKENIZER_PORT');

export interface ILatexTokenizerPort {
  /**
   * Tokenizes LaTeX source text, stripping commands, math environments, and comments,
   * while preserving exact line and column coordinates for every prose word.
   */
  tokenize(text: string): WordTokenVo[];
}
