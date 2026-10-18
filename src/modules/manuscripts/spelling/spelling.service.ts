/**
 * modules/manuscripts/spelling/spelling.service.ts
 * Deep Application Service for academic spell checking, LaTeX prose tokenization,
 * Levenshtein suggestion ranking, and custom project/user dictionary management.
 */

import { Injectable, Optional } from '@nestjs/common';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { SpellingRepository } from './spelling.repository';
import {
  AcademicSpellEngine,
  InvalidWordException,
  LanguageCodeVo,
  LatexProseTokenizer,
  MisspelledWord,
  SpellingReport,
} from './domain';
import {
  CheckSpellingDto,
  CustomDictionaryResponseDto,
  SpellingReportDto,
  SuggestionQueryDto,
} from './dto/spelling.dto';

export interface CheckSpellingQuery {
  text?: string;
  projectId?: string;
  docId?: string;
  language?: string;
  userId?: string;
  maxSuggestions?: number;
}

@Injectable()
export class SpellingService {
  private readonly tokenizer = new LatexProseTokenizer();
  private readonly spellEngine = new AcademicSpellEngine();

  constructor(
    @Optional() private readonly repository?: SpellingRepository,
    @Optional() private readonly docstoreService?: DocstoreService,
  ) {}

  private get repo(): SpellingRepository {
    if (!this.repository) {
      throw new Error('SpellingRepository is not configured');
    }
    return this.repository;
  }

  /**
   * Executes a spell check across inline text or a persisted document.
   */
  public async checkSpelling(
    query: CheckSpellingQuery,
  ): Promise<SpellingReport> {
    const language = LanguageCodeVo.create(query.language);
    const maxSuggestions = query.maxSuggestions ?? 5;

    let sourceText = query.text ?? '';
    if (!sourceText && query.projectId && query.docId && this.docstoreService) {
      const doc = await this.docstoreService.getDoc(
        query.projectId,
        query.docId,
      );
      sourceText = (doc.lines || []).join('\n');
    }

    const tokens = this.tokenizer.tokenize(sourceText);

    const customWordSet = new Set<string>();
    if (query.projectId) {
      const pWords = await this.repo.listProjectWords(query.projectId);
      for (const w of pWords) customWordSet.add(w.toLowerCase());
    }
    if (query.userId) {
      const uWords = await this.repo.listUserWords(query.userId);
      for (const w of uWords) customWordSet.add(w.toLowerCase());
    }

    const suggestionCache = new Map<string, string[]>();
    const errors: MisspelledWord[] = [];

    for (const token of tokens) {
      const normalized = token.normalized;
      if (customWordSet.has(normalized)) {
        continue;
      }

      const isCorrect =
        this.spellEngine.isCorrect(token.word, language) ||
        this.spellEngine.isCorrect(normalized, language);

      if (!isCorrect) {
        let suggestions = suggestionCache.get(normalized);
        if (!suggestions) {
          suggestions = this.spellEngine.getSuggestions(
            token.word,
            language,
            maxSuggestions,
          );
          suggestionCache.set(normalized, suggestions);
        }

        errors.push(
          new MisspelledWord({
            word: token.word,
            line: token.line,
            col: token.col,
            length: token.length,
            suggestions,
          }),
        );
      }
    }

    return new SpellingReport({
      language: language.code,
      totalWordsChecked: tokens.length,
      errors,
    });
  }

  /**
   * Checks document spelling for controller endpoint.
   */
  public async checkDocumentSpelling(
    projectId: string,
    userId: string,
    dto: CheckSpellingDto,
  ): Promise<SpellingReportDto> {
    const report = await this.checkSpelling({
      projectId,
      userId,
      text: dto.text,
      docId: dto.docId,
      language: dto.language,
    });
    return report.toJSON();
  }

  /**
   * Computes ranked candidate replacements for a potentially misspelled word.
   */
  public getSuggestions(query: SuggestionQueryDto): string[] {
    const trimmed = (query.word ?? '').trim();
    if (!trimmed) {
      return [];
    }

    const language = LanguageCodeVo.create(query.language);
    const maxSuggestions = Math.min(Math.max(query.maxSuggestions ?? 5, 1), 25);
    if (this.spellEngine.isCorrect(trimmed, language)) {
      return [];
    }
    return this.spellEngine.getSuggestions(trimmed, language, maxSuggestions);
  }

  /**
   * Adds a custom word to the project dictionary.
   */
  public async learnProjectWord(
    projectId: string,
    word: string,
  ): Promise<void> {
    const cleaned = this.validateAndNormalizeWord(word);
    await this.repo.addProjectWord(projectId, cleaned);
  }

  /**
   * Removes a custom word from the project dictionary.
   */
  public async unlearnProjectWord(
    projectId: string,
    word: string,
  ): Promise<boolean> {
    const cleaned = (word ?? '').trim().toLowerCase();
    if (!cleaned) return false;
    return this.repo.removeProjectWord(projectId, cleaned);
  }

  /**
   * Lists custom words in the project dictionary.
   */
  public async listProjectWords(
    projectId: string,
  ): Promise<CustomDictionaryResponseDto> {
    const words = await this.repo.listProjectWords(projectId);
    return {
      scope: 'PROJECT',
      words,
      count: words.length,
    };
  }

  /**
   * Adds a custom word to the user dictionary.
   */
  public async learnUserWord(userId: string, word: string): Promise<void> {
    const cleaned = this.validateAndNormalizeWord(word);
    await this.repo.addUserWord(userId, cleaned);
  }

  /**
   * Removes a custom word from the user dictionary.
   */
  public async unlearnUserWord(userId: string, word: string): Promise<boolean> {
    const cleaned = (word ?? '').trim().toLowerCase();
    if (!cleaned) return false;
    return this.repo.removeUserWord(userId, cleaned);
  }

  /**
   * Lists custom words in the user dictionary.
   */
  public async listUserWords(
    userId: string,
  ): Promise<CustomDictionaryResponseDto> {
    const words = await this.repo.listUserWords(userId);
    return {
      scope: 'USER',
      words,
      count: words.length,
    };
  }

  private validateAndNormalizeWord(raw: string): string {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length < 2) {
      throw new InvalidWordException(
        raw,
        'Learned word must be at least 2 characters long.',
      );
    }
    if (trimmed.length > 64) {
      throw new InvalidWordException(
        raw,
        'Learned word cannot exceed 64 characters.',
      );
    }
    if (/\s/.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word must be a single token without whitespace.',
      );
    }
    if (!/^[\p{L}\p{M}'’-]+$/u.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word may only contain letters, hyphens, or apostrophes.',
      );
    }
    return trimmed.toLowerCase();
  }
}
