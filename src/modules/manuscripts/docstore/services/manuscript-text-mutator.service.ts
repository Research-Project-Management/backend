/**
 * modules/manuscripts/docstore/services/manuscript-text-mutator.service.ts
 * Injectable wrapper delegating to pure in-process functions in domain/text-suggestion-mutator.ts.
 */

import { Injectable } from '@nestjs/common';
import {
  TrackChangeSuggestionSpec,
  applySuggestionToLines,
  applyBatchSuggestionsToLines,
} from '../domain/text-suggestion-mutator';

export type { TrackChangeSuggestionSpec };
export { applySuggestionToLines, applyBatchSuggestionsToLines };

@Injectable()
export class ManuscriptTextMutatorService {
  public applySuggestionToLines(
    lines: string[],
    record: TrackChangeSuggestionSpec,
  ): string[] {
    return applySuggestionToLines(lines, record);
  }

  public applyBatchSuggestionsToLines(
    lines: string[],
    changes: TrackChangeSuggestionSpec[],
  ): string[] {
    return applyBatchSuggestionsToLines(lines, changes);
  }
}
