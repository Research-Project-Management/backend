/**
 * spelling/core/use-cases/unlearn-word.use-case.ts
 * Inbound Use Case: Removes a word from the Project or User custom dictionary.
 */

import { ICustomDictionaryRepositoryPort } from '../ports/custom-dictionary-repository.port';
import { DictionaryScopeVo } from '../domain/value-objects/dictionary-scope.vo';

export interface UnlearnWordCommand {
  word: string;
  scope: 'PROJECT' | 'USER';
  projectId?: string;
  userId?: string;
}

export class UnlearnWordUseCase {
  constructor(private readonly customDictionary: ICustomDictionaryRepositoryPort) {}

  public async execute(command: UnlearnWordCommand): Promise<boolean> {
    const raw = (command.word || '').trim();
    if (!raw) return false;

    const scopeVo = DictionaryScopeVo.fromString(command.scope);

    if (scopeVo.isProject() && command.projectId) {
      return this.customDictionary.removeProjectWord(command.projectId, raw);
    }

    if (scopeVo.isUser() && command.userId) {
      return this.customDictionary.removeUserWord(command.userId, raw);
    }

    return false;
  }
}
