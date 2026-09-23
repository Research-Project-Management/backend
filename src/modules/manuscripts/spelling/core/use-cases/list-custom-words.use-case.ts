/**
 * spelling/core/use-cases/list-custom-words.use-case.ts
 * Inbound Use Case: Lists all custom words in the Project or User dictionary.
 */

import { ICustomDictionaryRepositoryPort } from '../ports/custom-dictionary-repository.port';
import { DictionaryScopeVo } from '../domain/value-objects/dictionary-scope.vo';

export interface ListCustomWordsQuery {
  scope: 'PROJECT' | 'USER';
  projectId?: string;
  userId?: string;
}

export class ListCustomWordsUseCase {
  constructor(private readonly customDictionary: ICustomDictionaryRepositoryPort) {}

  public async execute(query: ListCustomWordsQuery): Promise<string[]> {
    const scopeVo = DictionaryScopeVo.fromString(query.scope);

    if (scopeVo.isProject() && query.projectId) {
      return this.customDictionary.listProjectWords(query.projectId);
    }

    if (scopeVo.isUser() && query.userId) {
      return this.customDictionary.listUserWords(query.userId);
    }

    return [];
  }
}
