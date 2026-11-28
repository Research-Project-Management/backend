/**
 * spelling/domain/spelling.engine.ts
 * Async Hunspell-backed Spelling Engine (`nspell` + `.aff`/`.dic` dictionaries)
 * with in-flight load deduplication, bounded LRU caching, and CPU DoS guardrails.
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import nspell from 'nspell';
import { LRUCache } from 'lru-cache';
import {
  DICTIONARY_PACKAGES,
  SUPPORTED_LANGUAGES,
  type MisspelledWord,
  type SpellingReport,
  type SupportedLanguage,
} from '../types/spelling.types';
import {
  InvalidWordException,
  UnsupportedLanguageException,
} from './spelling.errors';

type NSpellInstance = ReturnType<typeof nspell>;

const MAX_CACHE_ENTRIES = 20_000;
const MAX_SUGGEST_WORD_LENGTH = 40;
const MAX_SUGGESTIONS_PER_CHECK = 100;
const DEFAULT_MAX_SUGGESTIONS = 5;

const LATEX_BUILTINS = new Set([
  'latex',
  'bibtex',
  'biblatex',
  'pdflatex',
  'xelatex',
  'lualatex',
  'tikz',
  'synctex',
  'arxiv',
  'overleaf',
  'doi',
  'isbn',
  'issn',
  'url',
  'pdf',
]);

function isAsciiDigitsOnly(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isShortUppercaseAcronym(word: string): boolean {
  if (word.length > 8) return false;
  for (let i = 0; i < word.length; i++) {
    const code = word.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isDigit) return false;
  }
  return true;
}

const SKIP_WORD_RULES: ReadonlyArray<(word: string) => boolean> = [
  (word) => !word || word.length <= 1,
  isAsciiDigitsOnly,
  isShortUppercaseAcronym,
  (word) => LATEX_BUILTINS.has(word.toLowerCase()),
];

export function normalizeLanguageCode(raw?: string): SupportedLanguage {
  if (!raw || !raw.trim()) return 'en-us';
  const normalized = raw.trim().toLowerCase().replace('_', '-');
  if (!Object.prototype.hasOwnProperty.call(DICTIONARY_PACKAGES, normalized)) {
    throw new UnsupportedLanguageException(raw, SUPPORTED_LANGUAGES);
  }
  return normalized as SupportedLanguage;
}

export function validateCustomWord(raw: string): string {
  const normalized = (raw ?? '').trim().toLowerCase();
  if (!normalized || normalized.length > 128 || /\s/.test(normalized)) {
    throw new InvalidWordException(
      raw,
      'Custom dictionary word must be a single non-empty token (max 128 chars)',
    );
  }
  return normalized;
}

@Injectable()
export class SpellingEngine {
  private readonly spellers = new Map<string, NSpellInstance>();
  private readonly loadingSpellers = new Map<string, Promise<NSpellInstance>>();
  private readonly wordCache = new LRUCache<
    string,
    { correct: boolean; suggestions?: string[] }
  >({ max: MAX_CACHE_ENTRIES });

  private async resolveDictionaryDir(packageName: string): Promise<string> {
    const candidates: string[] = [
      path.join(process.cwd(), 'node_modules', packageName),
      path.join(process.cwd(), 'backend', 'node_modules', packageName),
    ];
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(dir, 'node_modules', packageName));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const candidate of candidates) {
      try {
        await fs.promises.access(path.join(candidate, 'index.aff'));
        return candidate;
      } catch {
        // try next candidate
      }
    }
    throw new Error(`Hunspell dictionary package '${packageName}' not found`);
  }

  private async getSpeller(
    language: SupportedLanguage,
  ): Promise<{ packageName: string; speller: NSpellInstance }> {
    const packageName = DICTIONARY_PACKAGES[language];
    const cached = this.spellers.get(packageName);
    if (cached) return { packageName, speller: cached };

    let pending = this.loadingSpellers.get(packageName);
    if (!pending) {
      pending = (async () => {
        const packageDir = await this.resolveDictionaryDir(packageName);
        const [aff, dic] = await Promise.all([
          fs.promises.readFile(path.join(packageDir, 'index.aff')),
          fs.promises.readFile(path.join(packageDir, 'index.dic')),
        ]);
        const instance = nspell(aff, dic);
        this.spellers.set(packageName, instance);
        return instance;
      })().finally(() => {
        this.loadingSpellers.delete(packageName);
      });
      this.loadingSpellers.set(packageName, pending);
    }

    return { packageName, speller: await pending };
  }

  private shouldSkipWord(word: string): boolean {
    return SKIP_WORD_RULES.some((rule) => rule(word));
  }

  private checkSingleWord(
    word: string,
    packageName: string,
    speller: NSpellInstance,
    customWords?: ReadonlySet<string>,
  ): boolean {
    if (this.shouldSkipWord(word)) return true;
    const lower = word.toLowerCase();
    if (customWords?.has(lower)) return true;

    const cacheKey = `${packageName}:${word}`;
    const hit = this.wordCache.get(cacheKey);
    if (hit !== undefined) return hit.correct;

    const correct =
      speller.correct(word) || (lower !== word && speller.correct(lower));
    this.wordCache.set(cacheKey, { correct });
    return correct;
  }

  private getSuggestions(
    word: string,
    packageName: string,
    speller: NSpellInstance,
    maxSuggestions: number,
  ): { suggestions: string[]; computed: boolean } {
    if (word.length > MAX_SUGGEST_WORD_LENGTH) {
      return { suggestions: [], computed: false };
    }

    const cacheKey = `${packageName}:${word}`;
    const hit = this.wordCache.get(cacheKey);
    if (hit?.suggestions) {
      return {
        suggestions: hit.suggestions.slice(0, maxSuggestions),
        computed: false,
      };
    }

    const suggestions = speller
      .suggest(word)
      .slice(0, Math.max(maxSuggestions, DEFAULT_MAX_SUGGESTIONS));
    this.wordCache.set(cacheKey, {
      correct: hit?.correct ?? false,
      suggestions,
    });
    return {
      suggestions: suggestions.slice(0, maxSuggestions),
      computed: true,
    };
  }

  public async checkWords(
    words: readonly string[],
    rawLanguage?: string,
    customWords?: ReadonlySet<string>,
    maxSuggestions = DEFAULT_MAX_SUGGESTIONS,
  ): Promise<SpellingReport> {
    const language = normalizeLanguageCode(rawLanguage);
    if (words.length === 0) {
      return {
        language,
        totalWordsChecked: 0,
        misspelledCount: 0,
        errors: [],
      };
    }

    const { packageName, speller } = await this.getSpeller(language);
    const errors: MisspelledWord[] = [];
    const checkedWords = new Set<string>();
    let suggestionsComputed = 0;

    for (let i = 0; i < words.length; i++) {
      const word = (words[i] || '').trim();
      if (!word || checkedWords.has(word)) continue;
      checkedWords.add(word);

      if (!this.checkSingleWord(word, packageName, speller, customWords)) {
        let suggestions: string[] = [];
        if (suggestionsComputed < MAX_SUGGESTIONS_PER_CHECK) {
          const result = this.getSuggestions(
            word,
            packageName,
            speller,
            maxSuggestions,
          );
          suggestions = result.suggestions;
          if (result.computed) suggestionsComputed++;
        }
        errors.push({ word, suggestions });
      }
    }

    return {
      language,
      totalWordsChecked: checkedWords.size,
      misspelledCount: errors.length,
      errors,
    };
  }
}
