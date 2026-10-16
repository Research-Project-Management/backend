/**
 * modules/manuscripts/spelling/spelling.module.ts
 * NestJS Module for Manuscripts Spelling subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

// Controllers, Service & Repository
import {
  SpellingController,
  SpellingUtilityController,
} from './spelling.controller';
import { SpellingService } from './spelling.service';
import { SpellingRepository } from './spelling.repository';

// Ports & Adapters
import { LATEX_TOKENIZER_PORT } from './core/ports/latex-tokenizer.port';
import { SPELL_ENGINE_PORT } from './core/ports/spell-engine.port';
import { CUSTOM_DICTIONARY_REPOSITORY_PORT } from './core/ports/custom-dictionary-repository.port';

import { RegexLatexTokenizerAdapter } from './core/adapters/tokenizer/regex-latex-tokenizer.adapter';
import { AcademicSpellEngineAdapter } from './core/adapters/engine/academic-spell-engine.adapter';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [SpellingController, SpellingUtilityController],
  providers: [
    SpellingService,
    SpellingRepository,
    {
      provide: LATEX_TOKENIZER_PORT,
      useClass: RegexLatexTokenizerAdapter,
    },
    {
      provide: SPELL_ENGINE_PORT,
      useClass: AcademicSpellEngineAdapter,
    },
    {
      provide: CUSTOM_DICTIONARY_REPOSITORY_PORT,
      useExisting: SpellingRepository,
    },
  ],
  exports: [
    SpellingService,
    SpellingRepository,
    LATEX_TOKENIZER_PORT,
    SPELL_ENGINE_PORT,
    CUSTOM_DICTIONARY_REPOSITORY_PORT,
  ],
})
export class SpellingModule {}
