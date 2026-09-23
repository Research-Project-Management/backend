/**
 * spelling/core/use-cases/learn-word.use-case.ts
 * Inbound Use Case: Adds a new word to the Project or User custom dictionary.
 */

import { ICustomDictionaryRepositoryPort } from '../ports/custom-dictionary-repository.port';
import { DictionaryScopeVo } from '../domain/value-objects/dictionary-scope.vo';
import { InvalidWordException } from '../domain/exceptions/invalid-word.exception';

export interface LearnWordCommand {
  word: string;
  scope: 'PROJECT' | 'USER';
  projectId?: string;
  userId?: string;
}

export class LearnWordUseCase {
  constructor(private readonly customDictionary: ICustomDictionaryRepositoryPort) {}

  public async execute(command: LearnWordCommand): Promise<void> {
    const raw = command.word ? command.word.trim() : '';

    if (!raw || /\s/.test(raw) || !/^[a-zA-ZÀ-ÿ0-9_:.\\-]+$/.test(raw)) {
      throw new InvalidWordException(
        command.word,
        'Word must not contain whitespace or invalid symbols'
      );
    }

    const scopeVo = DictionaryScopeVo.fromString(command.scope);

    if (scopeVo.isProject()) {
      if (!command.projectId) {
        throw new InvalidWordException(raw, 'projectId is required for project dictionary');
      }
      await this.customDictionary.addProjectWord(command.projectId, raw);
    } else {
      if (!command.userId) {
        throw new InvalidWordException(raw, 'userId is required for user dictionary');
      }
      await this.customDictionary.addUserWord(command.userId, raw);
    }
  }
}
