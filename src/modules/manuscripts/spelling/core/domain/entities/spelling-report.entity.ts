/**
 * spelling/core/domain/entities/spelling-report.entity.ts
 * Aggregate Entity representing the comprehensive spelling check report for a document.
 */

import { MisspelledWord } from './misspelled-word.entity';

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
