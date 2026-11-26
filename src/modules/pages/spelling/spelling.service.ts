/**
 * spelling/spelling.service.ts
 * Application service coordinating cached project dictionaries and Hunspell checks.
 */

import { Injectable } from '@nestjs/common';
import { LRUCache } from 'lru-cache';
import { SpellingRepository } from './spelling.repository';
import {
  SpellingEngine,
  normalizeLanguageCode,
  validateCustomWord,
} from './domain/spelling.engine';
import { InvalidWordException } from './domain/spelling.errors';
import type { CheckSpellingDto } from './dto/spelling.dto';
import type {
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
  private cacheEpoch = 0;

  constructor(
    private readonly repository: SpellingRepository,
    private readonly engine: SpellingEngine,
  ) {}

  private invalidateSpaceCache(spaceId: string): void {
    this.cacheEpoch++;
    this.dictionaryCache.delete(spaceId);
    this.pendingLoads.delete(spaceId);
  }

  private async getCachedWordSet(spaceId: string): Promise<ReadonlySet<string>> {
    const cached = this.dictionaryCache.get(spaceId);
    if (cached) return cached;

    let pending = this.pendingLoads.get(spaceId);
    if (!pending) {
      const loadEpoch = this.cacheEpoch;
      pending = this.repository
        .listWords(spaceId)
        .then((words) => {
          const wordSet = new Set(words.map((w) => w.toLowerCase()));
          if (this.cacheEpoch === loadEpoch) {
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
    dto: CheckSpellingDto,
  ): Promise<SpellingReport> {
    const language = normalizeLanguageCode(dto.language);
    const words = Array.isArray(dto.words) ? dto.words : [];
    if (words.length === 0) {
      return {
        language,
        totalWordsChecked: 0,
        misspelledCount: 0,
        errors: [],
      };
    }

    const customWords = await this.getCachedWordSet(spaceId);
    return this.engine.checkWords(words, language, customWords);
  }

  public async listWords(spaceId: string): Promise<CustomDictionaryResult> {
    const loadEpoch = this.cacheEpoch;
    const words = await this.repository.listWords(spaceId);
    if (this.cacheEpoch === loadEpoch) {
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
      throw new InvalidWordException(
        word,
        `Project dictionary limit (${MAX_WORDS_PER_SPACE} words) reached`,
      );
    }

    await this.repository.addWord(spaceId, normalizedWord, createdById);
    this.invalidateSpaceCache(spaceId);
    return normalizedWord;
  }

  public async unlearnWord(spaceId: string, word: string): Promise<boolean> {
    const normalizedWord = (word ?? '').trim().toLowerCase();
    if (!normalizedWord) return false;

    const removed = await this.repository.removeWord(spaceId, normalizedWord);
    this.invalidateSpaceCache(spaceId);
    return removed;
  }
}
