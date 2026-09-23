/**
 * spelling/core/adapters/storage/in-memory-custom-dictionary.adapter.ts
 * In-memory adapter implementing ICustomDictionaryRepositoryPort.
 * Provides fast concurrent access for custom dictionary words.
 */

import { Injectable } from '@nestjs/common';
import { ICustomDictionaryRepositoryPort } from '../../ports/custom-dictionary-repository.port';

@Injectable()
export class InMemoryCustomDictionaryAdapter implements ICustomDictionaryRepositoryPort {
  // Key format: `project:${projectId}` -> Set<word>
  private readonly projectWords = new Map<string, Set<string>>();
  // Key format: `user:${userId}` -> Set<word>
  private readonly userWords = new Map<string, Set<string>>();

  public async listProjectWords(projectId: string): Promise<string[]> {
    const set = this.projectWords.get(projectId);
    return set ? Array.from(set).sort() : [];
  }

  public async listUserWords(userId: string): Promise<string[]> {
    const set = this.userWords.get(userId);
    return set ? Array.from(set).sort() : [];
  }

  public async addProjectWord(projectId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    let set = this.projectWords.get(projectId);
    if (!set) {
      set = new Set<string>();
      this.projectWords.set(projectId, set);
    }
    set.add(clean);
  }

  public async addUserWord(userId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    let set = this.userWords.get(userId);
    if (!set) {
      set = new Set<string>();
      this.userWords.set(userId, set);
    }
    set.add(clean);
  }

  public async removeProjectWord(projectId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    const set = this.projectWords.get(projectId);
    if (!set) return false;
    return set.delete(clean);
  }

  public async removeUserWord(userId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    const set = this.userWords.get(userId);
    if (!set) return false;
    return set.delete(clean);
  }

  public async isCustomWord(word: string, projectId?: string, userId?: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    if (!clean) return false;

    if (projectId) {
      const pSet = this.projectWords.get(projectId);
      if (pSet && pSet.has(clean)) return true;
    }

    if (userId) {
      const uSet = this.userWords.get(userId);
      if (uSet && uSet.has(clean)) return true;
    }

    return false;
  }

  public clear(): void {
    this.projectWords.clear();
    this.userWords.clear();
  }
}
