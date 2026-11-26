/**
 * spelling/spelling.module.ts
 * NestJS Module for Pages Spelling & Custom Project Dictionary.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { SpellingController } from './spelling.controller';
import { SpellingService } from './spelling.service';
import { SpellingRepository } from './spelling.repository';
import { SpellingEngine } from './domain/spelling.engine';

@Module({
  imports: [PrismaModule],
  controllers: [SpellingController],
  providers: [SpellingService, SpellingRepository, SpellingEngine],
  exports: [SpellingService],
})
export class SpellingModule {}
