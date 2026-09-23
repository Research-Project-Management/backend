/**
 * spelling/core/use-cases/get-suggestions.use-case.ts
 * Inbound Use Case: Retrieves spelling suggestions for a single queried word.
 */

import { ISpellEnginePort } from '../ports/spell-engine.port';
import { LanguageCodeVo } from '../domain/value-objects/language-code.vo';

export interface GetSuggestionsQuery {
  word: string;
  language?: string;
  maxSuggestions?: number;
}

export class GetSuggestionsUseCase {
  constructor(private readonly spellEngine: ISpellEnginePort) {}

  public execute(query: GetSuggestionsQuery): string[] {
    if (!query.word || query.word.trim() === '') {
      return [];
    }

    const langVo = LanguageCodeVo.create(query.language);
    return this.spellEngine.getSuggestions(
      query.word,
      langVo,
      query.maxSuggestions || 5
    );
  }
}
