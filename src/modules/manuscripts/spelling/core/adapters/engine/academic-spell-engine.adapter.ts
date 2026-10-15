/**
 * spelling/core/adapters/engine/academic-spell-engine.adapter.ts
 * Adapter delegating ISpellEnginePort to pure domain AcademicSpellEngine.
 */

import { Injectable } from '@nestjs/common';
import { ISpellEnginePort } from '@/modules/manuscripts/spelling/core/ports/spell-engine.port';
import { LanguageCodeVo } from '@/modules/manuscripts/spelling/core/domain/value-objects/language-code.vo';
import { AcademicSpellEngine } from '@/modules/manuscripts/spelling/domain/academic-spell.engine';

@Injectable()
export class AcademicSpellEngineAdapter implements ISpellEnginePort {
  private readonly engine = new AcademicSpellEngine();

  public isCorrect(word: string, language: LanguageCodeVo): boolean {
    return this.engine.isCorrect(word, language);
  }

  public getSuggestions(
    word: string,
    language: LanguageCodeVo,
    maxSuggestions = 5,
  ): string[] {
    return this.engine.getSuggestions(word, language, maxSuggestions);
  }

  public getSupportedLanguages(): string[] {
    return this.engine.getSupportedLanguages();
  }
}
