/**
 * spelling/spelling.module.ts
 * NestJS Module configuring Ports, Adapters, Use Cases, Controller & Service
 * for Manuscripts Spelling subsystem.
 */

import { Module, forwardRef } from '@nestjs/common';
import { DocstoreModule } from '../docstore/docstore.module';

// Controllers & Service
import { SpellingController, SpellingUtilityController } from './spelling.controller';
import { SpellingService } from './spelling.service';

// Ports
import { LATEX_TOKENIZER_PORT, ILatexTokenizerPort } from './core/ports/latex-tokenizer.port';
import { SPELL_ENGINE_PORT, ISpellEnginePort } from './core/ports/spell-engine.port';
import {
  CUSTOM_DICTIONARY_REPOSITORY_PORT,
  ICustomDictionaryRepositoryPort,
} from './core/ports/custom-dictionary-repository.port';

// Adapters
import { RegexLatexTokenizerAdapter } from './core/adapters/tokenizer/regex-latex-tokenizer.adapter';
import { AcademicSpellEngineAdapter } from './core/adapters/engine/academic-spell-engine.adapter';
import { PrismaCustomDictionaryAdapter } from './core/adapters/storage/prisma-custom-dictionary.adapter';

// Use Cases
import { CheckSpellingUseCase } from './core/use-cases/check-spelling.use-case';
import { GetSuggestionsUseCase } from './core/use-cases/get-suggestions.use-case';
import { LearnWordUseCase } from './core/use-cases/learn-word.use-case';
import { UnlearnWordUseCase } from './core/use-cases/unlearn-word.use-case';
import { ListCustomWordsUseCase } from './core/use-cases/list-custom-words.use-case';

@Module({
  imports: [forwardRef(() => DocstoreModule)],
  controllers: [SpellingController, SpellingUtilityController],
  providers: [
    // 1. Adapters bound to Ports
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
      useClass: PrismaCustomDictionaryAdapter,
    },

    // 2. Inbound Use Cases
    {
      provide: CheckSpellingUseCase,
      inject: [LATEX_TOKENIZER_PORT, SPELL_ENGINE_PORT, CUSTOM_DICTIONARY_REPOSITORY_PORT],
      useFactory: (
        tokenizer: ILatexTokenizerPort,
        spellEngine: ISpellEnginePort,
        customDict: ICustomDictionaryRepositoryPort
      ) => new CheckSpellingUseCase(tokenizer, spellEngine, customDict),
    },
    {
      provide: GetSuggestionsUseCase,
      inject: [SPELL_ENGINE_PORT],
      useFactory: (spellEngine: ISpellEnginePort) => new GetSuggestionsUseCase(spellEngine),
    },
    {
      provide: LearnWordUseCase,
      inject: [CUSTOM_DICTIONARY_REPOSITORY_PORT],
      useFactory: (customDict: ICustomDictionaryRepositoryPort) => new LearnWordUseCase(customDict),
    },
    {
      provide: UnlearnWordUseCase,
      inject: [CUSTOM_DICTIONARY_REPOSITORY_PORT],
      useFactory: (customDict: ICustomDictionaryRepositoryPort) => new UnlearnWordUseCase(customDict),
    },
    {
      provide: ListCustomWordsUseCase,
      inject: [CUSTOM_DICTIONARY_REPOSITORY_PORT],
      useFactory: (customDict: ICustomDictionaryRepositoryPort) => new ListCustomWordsUseCase(customDict),
    },

    // 3. Facade Service
    SpellingService,
  ],
  exports: [
    SpellingService,
    LATEX_TOKENIZER_PORT,
    SPELL_ENGINE_PORT,
    CUSTOM_DICTIONARY_REPOSITORY_PORT,
  ],
})
export class SpellingModule {}
