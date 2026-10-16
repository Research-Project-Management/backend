/**
 * modules/manuscripts/spelling/spelling.service.ts
 * Deep module facade orchestrating LaTeX Spell Checking, Suggestions, and Custom Dictionaries.
 * Executes directly via SpellingRepository and pure domain AcademicSpellEngine.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { CheckSpellingUseCase } from './core/use-cases/check-spelling.use-case';
import { GetSuggestionsUseCase } from './core/use-cases/get-suggestions.use-case';
import { LearnWordUseCase } from './core/use-cases/learn-word.use-case';
import { UnlearnWordUseCase } from './core/use-cases/unlearn-word.use-case';
import { ListCustomWordsUseCase } from './core/use-cases/list-custom-words.use-case';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import {
  AcademicSpellEngine,
  LanguageCodeVo,
  InvalidWordException,
} from './domain';
import { SpellingRepository } from './spelling.repository';
import {
  CheckSpellingDto,
  SuggestionQueryDto,
  SpellingReportDto,
  CustomDictionaryResponseDto,
} from './dto/spelling.dto';

@Injectable()
export class SpellingService {
  private readonly logger = new Logger(SpellingService.name);
  private readonly spellEngine = new AcademicSpellEngine();

  constructor(
    @Optional() private readonly checkSpellingUseCase?: CheckSpellingUseCase,
    @Optional() private readonly getSuggestionsUseCase?: GetSuggestionsUseCase,
    @Optional() private readonly learnWordUseCase?: LearnWordUseCase,
    @Optional() private readonly unlearnWordUseCase?: UnlearnWordUseCase,
    @Optional()
    private readonly listCustomWordsUseCase?: ListCustomWordsUseCase,
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional() private readonly repository?: SpellingRepository,
  ) {}

  /**
   * Checks spelling of a document's content (via direct text or docId).
   */
  public async checkDocumentSpelling(
    projectId: string,
    userId: string,
    dto: CheckSpellingDto,
  ): Promise<SpellingReportDto> {
    let contentToScan = dto.text || '';

    // If docId is provided and text is empty, load from Docstore
    if (!contentToScan && dto.docId && this.docstoreService) {
      try {
        const doc = await this.docstoreService.getDoc(projectId, dto.docId);
        contentToScan = (doc.lines || []).join('\n');
      } catch (err: unknown) {
        this.logger.warn(
          `Could not load doc ${dto.docId} from docstore: ${(err as Error)?.message}`,
        );
      }
    }

    if (this.repository) {
      const [projectWords, userWords] = await Promise.all([
        projectId ? this.repository.listProjectWords(projectId) : [],
        userId ? this.repository.listUserWords(userId) : [],
      ]);

      const report = this.spellEngine.checkText(contentToScan, dto.language, [
        ...projectWords,
        ...userWords,
      ]);
      return report.toJSON();
    }

    if (this.checkSpellingUseCase) {
      const report = await this.checkSpellingUseCase.execute({
        text: contentToScan,
        projectId,
        userId,
        language: dto.language,
      });
      return report.toJSON();
    }

    const report = this.spellEngine.checkText(contentToScan, dto.language, []);
    return report.toJSON();
  }

  /**
   * Retrieves ranked candidate suggestions for a word.
   */
  public getSuggestions(query: SuggestionQueryDto): string[] {
    if (this.repository || !this.getSuggestionsUseCase) {
      if (!query.word || query.word.trim() === '') {
        return [];
      }
      const langVo = LanguageCodeVo.create(query.language);
      return this.spellEngine.getSuggestions(
        query.word,
        langVo,
        query.maxSuggestions || 5,
      );
    }

    return this.getSuggestionsUseCase.execute({
      word: query.word,
      language: query.language,
      maxSuggestions: query.maxSuggestions,
    });
  }

  /**
   * Learn word in Project dictionary.
   */
  public async learnProjectWord(
    projectId: string,
    word: string,
  ): Promise<void> {
    if (this.repository) {
      const raw = AcademicSpellEngine.validateCustomWord(word);
      if (!projectId) {
        throw new InvalidWordException(
          raw,
          'projectId is required for project dictionary',
        );
      }
      await this.repository.addProjectWord(projectId, raw);
      return;
    }

    if (this.learnWordUseCase) {
      await this.learnWordUseCase.execute({
        word,
        scope: 'PROJECT',
        projectId,
      });
    }
  }

  /**
   * Remove word from Project dictionary.
   */
  public async unlearnProjectWord(
    projectId: string,
    word: string,
  ): Promise<boolean> {
    if (this.repository) {
      const raw = (word || '').trim();
      if (!raw || !projectId) return false;
      return this.repository.removeProjectWord(projectId, raw);
    }

    if (this.unlearnWordUseCase) {
      return this.unlearnWordUseCase.execute({
        word,
        scope: 'PROJECT',
        projectId,
      });
    }
    return false;
  }

  /**
   * List Project custom dictionary words.
   */
  public async listProjectWords(
    projectId: string,
  ): Promise<CustomDictionaryResponseDto> {
    const words = this.repository
      ? projectId
        ? await this.repository.listProjectWords(projectId)
        : []
      : await this.listCustomWordsUseCase!.execute({
          scope: 'PROJECT',
          projectId,
        });
    return {
      scope: 'PROJECT',
      words,
      count: words.length,
    };
  }

  /**
   * Learn word in User personal dictionary.
   */
  public async learnUserWord(userId: string, word: string): Promise<void> {
    if (this.repository) {
      const raw = AcademicSpellEngine.validateCustomWord(word);
      if (!userId) {
        throw new InvalidWordException(
          raw,
          'userId is required for user dictionary',
        );
      }
      await this.repository.addUserWord(userId, raw);
      return;
    }

    if (this.learnWordUseCase) {
      await this.learnWordUseCase.execute({
        word,
        scope: 'USER',
        userId,
      });
    }
  }

  /**
   * Remove word from User personal dictionary.
   */
  public async unlearnUserWord(userId: string, word: string): Promise<boolean> {
    if (this.repository) {
      const raw = (word || '').trim();
      if (!raw || !userId) return false;
      return this.repository.removeUserWord(userId, raw);
    }

    if (this.unlearnWordUseCase) {
      return this.unlearnWordUseCase.execute({
        word,
        scope: 'USER',
        userId,
      });
    }
    return false;
  }

  /**
   * List User personal dictionary words.
   */
  public async listUserWords(
    userId: string,
  ): Promise<CustomDictionaryResponseDto> {
    const words = this.repository
      ? userId
        ? await this.repository.listUserWords(userId)
        : []
      : await this.listCustomWordsUseCase!.execute({
          scope: 'USER',
          userId,
        });
    return {
      scope: 'USER',
      words,
      count: words.length,
    };
  }
}
