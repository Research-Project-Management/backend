/**
 * modules/manuscripts/clsi/core/pipeline/word-count.use-case.ts
 * Use case computing word count and structural stats for a LaTeX document
 */

import { IWordCounter, WordCountStats } from '../ports/artifacts.port';

export interface WordCountResponse {
  success: boolean;
  stats?: WordCountStats;
  error?: string;
}

export class WordCountUseCase {
  constructor(private readonly wordCounter: IWordCounter) {}

  public execute(source: string): WordCountResponse {
    if (!source || typeof source !== 'string') {
      return {
        success: false,
        error: 'Missing or invalid source code for word counting',
      };
    }

    try {
      const stats = this.wordCounter.count(source);
      return {
        success: true,
        stats,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Failed to calculate word count',
      };
    }
  }
}
