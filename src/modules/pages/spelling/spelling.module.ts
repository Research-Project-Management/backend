/**
 * modules/manuscripts/spelling/spelling.module.ts
 * NestJS Module for Manuscripts Spelling subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';

// Controllers, Service & Repository
import {
  SpellingController,
  SpellingUtilityController,
} from './spelling.controller';
import { SpellingService } from './spelling.service';
import { SpellingRepository } from './spelling.repository';

// Domain
import { LatexTokenizer, SpellEngine } from './domain';

@Module({
  imports: [PrismaModule, DocstoreModule],
  controllers: [SpellingController, SpellingUtilityController],
  providers: [
    SpellingService,
    SpellingRepository,
    LatexTokenizer,
    SpellEngine,
  ],
  exports: [
    SpellingService,
    SpellingRepository,
    LatexTokenizer,
    SpellEngine,
  ],
})
export class SpellingModule {}
