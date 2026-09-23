/**
 * spelling/core/domain/entities/misspelled-word.entity.ts
 * Entity representing an individual misspelled word detected during a document check.
 */

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
    this.suggestions = Object.freeze(props.suggestions ? [...props.suggestions] : []);
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
