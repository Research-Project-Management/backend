/**
 * spelling/core/use-cases/check-spelling.use-case.ts
 * Inbound Use Case: Scans a LaTeX document for misspelled words, masking commands & math,
 * verifying against system dictionary and project/user custom dictionaries.
 */

import { ILatexTokenizerPort } from '../ports/latex-tokenizer.port';
import { ISpellEnginePort } from '../ports/spell-engine.port';
import { ICustomDictionaryRepositoryPort } from '../ports/custom-dictionary-repository.port';
import { LanguageCodeVo } from '../domain/value-objects/language-code.vo';
import { MisspelledWord } from '../domain/entities/misspelled-word.entity';
import { SpellingReport } from '../domain/entities/spelling-report.entity';

export interface CheckSpellingCommand {
  text?: string;
  projectId?: string;
  userId?: string;
  language?: string;
}

export class CheckSpellingUseCase {
  constructor(
    private readonly tokenizer: ILatexTokenizerPort,
    private readonly spellEngine: ISpellEnginePort,
    private readonly customDictionary: ICustomDictionaryRepositoryPort
  ) {}

  public async execute(command: CheckSpellingCommand): Promise<SpellingReport> {
    const rawText = command.text || '';
    const langVo = LanguageCodeVo.create(command.language);

    if (!rawText.trim()) {
      return new SpellingReport({
        language: langVo.code,
        totalWordsChecked: 0,
        errors: [],
      });
    }

    // 1. Tokenize LaTeX text into prose word tokens
    const tokens = this.tokenizer.tokenize(rawText);

    // 2. Fetch all custom words for fast lookup cache
    const projectWords = command.projectId
      ? await this.customDictionary.listProjectWords(command.projectId)
      : [];
    const userWords = command.userId
      ? await this.customDictionary.listUserWords(command.userId)
      : [];

    const customSet = new Set<string>([
      ...projectWords.map((w) => w.toLowerCase()),
      ...userWords.map((w) => w.toLowerCase()),
    ]);

    const errors: MisspelledWord[] = [];
    const suggestionsCache = new Map<string, string[]>();

    // 3. Check each token
    for (const token of tokens) {
      const lower = token.normalized;

      // Skip custom learned words
      if (customSet.has(lower)) {
        continue;
      }

      // Skip correctly spelled words
      if (this.spellEngine.isCorrect(token.word, langVo)) {
        continue;
      }

      // Generate suggestions (using memoization for repeated words)
      let suggestions = suggestionsCache.get(lower);
      if (!suggestions) {
        suggestions = this.spellEngine.getSuggestions(token.word, langVo, 5);
        suggestionsCache.set(lower, suggestions);
      }

      errors.push(
        new MisspelledWord({
          word: token.word,
          line: token.line,
          col: token.col,
          length: token.length,
          suggestions,
        })
      );
    }

    return new SpellingReport({
      language: langVo.code,
      totalWordsChecked: tokens.length,
      errors,
    });
  }
}
