/**
 * spelling/spelling.service.ts
 * Application service coordinating cached project dictionaries and Hunspell checks.
 */

import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { SpellingRepository } from './spelling.repository';
import { SpellingEngine, validateCustomWord } from './domain/spelling.engine';
import { DictionaryLimitExceededException } from './domain/spelling.errors';
import type {
  CheckSpellingInput,
  CustomDictionaryResult,
  SpellingReport,
} from './types/spelling.types';

const DICTIONARY_CACHE_TTL_MS = 60_000;
const MAX_WORDS_PER_SPACE = 2_000;

@Injectable()
export class SpellingService {
  private readonly dictionaryCache = new LRUCache<string, ReadonlySet<string>>({
    max: 500,
    ttl: DICTIONARY_CACHE_TTL_MS,
  });
  private readonly pendingLoads = new Map<
    string,
    Promise<ReadonlySet<string>>
  >();
  private readonly spaceEpochs = new Map<string, number>();

  constructor(
    private readonly repository: SpellingRepository,
    private readonly engine: SpellingEngine,
  ) {}

  private getEpoch(spaceId: string): number {
    return this.spaceEpochs.get(spaceId) ?? 0;
  }

  private invalidateSpaceCache(spaceId: string): void {
    this.spaceEpochs.set(spaceId, this.getEpoch(spaceId) + 1);
    this.dictionaryCache.delete(spaceId);
    this.pendingLoads.delete(spaceId);
  }

  private async getCachedWordSet(
    spaceId: string,
  ): Promise<ReadonlySet<string>> {
    const cached = this.dictionaryCache.get(spaceId);
    if (cached) return cached;

    let pending = this.pendingLoads.get(spaceId);
    if (!pending) {
      const loadEpoch = this.getEpoch(spaceId);
      pending = this.repository
        .listWords(spaceId)
        .then((words) => {
          const wordSet = new Set(words.map((w) => w.toLowerCase()));
          if (this.getEpoch(spaceId) === loadEpoch) {
            this.dictionaryCache.set(spaceId, wordSet);
          }
          return wordSet;
        })
        .finally(() => {
          if (this.pendingLoads.get(spaceId) === pending) {
            this.pendingLoads.delete(spaceId);
          }
        });
      this.pendingLoads.set(spaceId, pending);
    }

    return pending;
  }

  public async check(
    spaceId: string,
    input: CheckSpellingInput,
  ): Promise<SpellingReport> {
    const customWords =
      input.words.length > 0 ? await this.getCachedWordSet(spaceId) : undefined;
    return this.engine.checkWords(input.words, input.language, customWords);
  }

  public async listWords(spaceId: string): Promise<CustomDictionaryResult> {
    const loadEpoch = this.getEpoch(spaceId);
    const words = await this.repository.listWords(spaceId);
    if (this.getEpoch(spaceId) === loadEpoch) {
      this.dictionaryCache.set(
        spaceId,
        new Set(words.map((w) => w.toLowerCase())),
      );
    }
    return { words, count: words.length };
  }

  public async learnWord(
    spaceId: string,
    word: string,
    createdById?: string,
  ): Promise<string> {
    const normalizedWord = validateCustomWord(word);
    const existing = await this.getCachedWordSet(spaceId);
    if (existing.has(normalizedWord)) {
      return normalizedWord;
    }
    if (existing.size >= MAX_WORDS_PER_SPACE) {
      throw new DictionaryLimitExceededException(MAX_WORDS_PER_SPACE);
    }

    await this.repository.addWord(spaceId, normalizedWord, createdById);
    this.invalidateSpaceCache(spaceId);
    return normalizedWord;
  }

  public async unlearnWord(
    spaceId: string,
    word: string,
  ): Promise<{ removed: boolean; word: string }> {
    const normalizedWord = (word ?? '').trim().toLowerCase();
    if (!normalizedWord) return { removed: false, word: '' };

    const removed = await this.repository.removeWord(spaceId, normalizedWord);
    this.invalidateSpaceCache(spaceId);
    return { removed, word: normalizedWord };
  }
}
