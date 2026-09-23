/**
 * spelling/spelling.service.ts
 * Facade Service orchestrating LaTeX Spell Checking, Suggestions, and Custom Dictionaries.
 */

import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { CheckSpellingUseCase } from './core/use-cases/check-spelling.use-case';
import { GetSuggestionsUseCase } from './core/use-cases/get-suggestions.use-case';
import { LearnWordUseCase } from './core/use-cases/learn-word.use-case';
import { UnlearnWordUseCase } from './core/use-cases/unlearn-word.use-case';
import { ListCustomWordsUseCase } from './core/use-cases/list-custom-words.use-case';
import { DocstoreService } from '../docstore/docstore.service';
import {
  CheckSpellingDto,
  SuggestionQueryDto,
  SpellingReportDto,
  CustomDictionaryResponseDto,
} from './dto/spelling.dto';

@Injectable()
export class SpellingService {
  private readonly logger = new Logger(SpellingService.name);

  constructor(
    private readonly checkSpellingUseCase: CheckSpellingUseCase,
    private readonly getSuggestionsUseCase: GetSuggestionsUseCase,
    private readonly learnWordUseCase: LearnWordUseCase,
    private readonly unlearnWordUseCase: UnlearnWordUseCase,
    private readonly listCustomWordsUseCase: ListCustomWordsUseCase,
    @Optional()
    @Inject(forwardRef(() => DocstoreService))
    private readonly docstoreService?: DocstoreService
  ) {}

  /**
   * Checks spelling of a document's content (via direct text or docId).
   */
  public async checkDocumentSpelling(
    projectId: string,
    userId: string,
    dto: CheckSpellingDto
  ): Promise<SpellingReportDto> {
    let contentToScan = dto.text || '';

    // If docId is provided and text is empty, load from Docstore
    if (!contentToScan && dto.docId && this.docstoreService) {
      try {
        const doc = await this.docstoreService.getDoc(projectId, dto.docId);
        contentToScan = (doc.lines || []).join('\n');
      } catch (err: any) {
        this.logger.warn(`Could not load doc ${dto.docId} from docstore: ${err.message}`);
      }
    }

    const report = await this.checkSpellingUseCase.execute({
      text: contentToScan,
      projectId,
      userId,
      language: dto.language,
    });

    return report.toJSON() as SpellingReportDto;
  }

  /**
   * Retrieves ranked candidate suggestions for a word.
   */
  public getSuggestions(query: SuggestionQueryDto): string[] {
    return this.getSuggestionsUseCase.execute({
      word: query.word,
      language: query.language,
      maxSuggestions: query.maxSuggestions,
    });
  }

  /**
   * Learn word in Project dictionary.
   */
  public async learnProjectWord(projectId: string, word: string): Promise<void> {
    await this.learnWordUseCase.execute({
      word,
      scope: 'PROJECT',
      projectId,
    });
  }

  /**
   * Remove word from Project dictionary.
   */
  public async unlearnProjectWord(projectId: string, word: string): Promise<boolean> {
    return this.unlearnWordUseCase.execute({
      word,
      scope: 'PROJECT',
      projectId,
    });
  }

  /**
   * List Project custom dictionary words.
   */
  public async listProjectWords(projectId: string): Promise<CustomDictionaryResponseDto> {
    const words = await this.listCustomWordsUseCase.execute({
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
    await this.learnWordUseCase.execute({
      word,
      scope: 'USER',
      userId,
    });
  }

  /**
   * Remove word from User personal dictionary.
   */
  public async unlearnUserWord(userId: string, word: string): Promise<boolean> {
    return this.unlearnWordUseCase.execute({
      word,
      scope: 'USER',
      userId,
    });
  }

  /**
   * List User personal dictionary words.
   */
  public async listUserWords(userId: string): Promise<CustomDictionaryResponseDto> {
    const words = await this.listCustomWordsUseCase.execute({
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
