/**
 * spelling/core/domain/value-objects/word-token.vo.ts
 * Value Object representing an extracted word token and its precise location in a document.
 */

import { InvalidWordException } from '../exceptions/invalid-word.exception';

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
