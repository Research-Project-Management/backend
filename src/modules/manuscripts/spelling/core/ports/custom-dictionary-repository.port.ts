/**
 * spelling/core/ports/custom-dictionary-repository.port.ts
 * Outbound SPI Port for storing and querying project and user custom dictionary words.
 */

export const CUSTOM_DICTIONARY_REPOSITORY_PORT = Symbol('CUSTOM_DICTIONARY_REPOSITORY_PORT');

export interface ICustomDictionaryRepositoryPort {
  /**
   * List all custom words learned for a specific project.
   */
  listProjectWords(projectId: string): Promise<string[]>;

  /**
   * List all custom words learned for a specific user.
   */
  listUserWords(userId: string): Promise<string[]>;

  /**
   * Add a word to the project's custom dictionary.
   */
  addProjectWord(projectId: string, word: string): Promise<void>;

  /**
   * Add a word to the user's personal dictionary.
   */
  addUserWord(userId: string, word: string): Promise<void>;

  /**
   * Remove a word from the project's custom dictionary. Returns true if removed.
   */
  removeProjectWord(projectId: string, word: string): Promise<boolean>;

  /**
   * Remove a word from the user's personal dictionary. Returns true if removed.
   */
  removeUserWord(userId: string, word: string): Promise<boolean>;

  /**
   * Fast check if a word is registered as a custom word in either the project or user scope.
   */
  isCustomWord(word: string, projectId?: string, userId?: string): Promise<boolean>;
}
