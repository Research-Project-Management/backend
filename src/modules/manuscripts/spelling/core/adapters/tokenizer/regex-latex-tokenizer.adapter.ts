/**
 * spelling/core/adapters/tokenizer/regex-latex-tokenizer.adapter.ts
 * Adapter delegating ILatexTokenizerPort to pure domain LatexProseTokenizer.
 */

import { Injectable } from '@nestjs/common';
import { ILatexTokenizerPort } from '@/modules/manuscripts/spelling/core/ports/latex-tokenizer.port';
import { WordTokenVo } from '@/modules/manuscripts/spelling/core/domain/value-objects/word-token.vo';
import { LatexProseTokenizer } from '@/modules/manuscripts/spelling/domain/academic-spell.engine';

@Injectable()
export class RegexLatexTokenizerAdapter implements ILatexTokenizerPort {
  private readonly tokenizer = new LatexProseTokenizer();

  public tokenize(text: string): WordTokenVo[] {
    return this.tokenizer.tokenize(text);
  }
}
