/**
 * modules/manuscripts/diagnostics/diagnostics.module.ts
 * NestJS Module for Manuscripts Diagnostics subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import {
  ErrorKnowledgeBase,
  CompileLogAnalyzer,
  SyntaxLinter,
} from './domain';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

@Module({
  imports: [DocstoreModule],
  controllers: [DiagnosticsController],
  providers: [
    ErrorKnowledgeBase,
    {
      provide: CompileLogAnalyzer,
      inject: [ErrorKnowledgeBase],
      useFactory: (kb: ErrorKnowledgeBase) => new CompileLogAnalyzer(kb),
    },
    {
      provide: SyntaxLinter,
      inject: [ErrorKnowledgeBase],
      useFactory: (kb: ErrorKnowledgeBase) => new SyntaxLinter(kb),
    },
    DiagnosticsService,
  ],
  exports: [
    DiagnosticsService,
    ErrorKnowledgeBase,
    CompileLogAnalyzer,
    SyntaxLinter,
  ],
})
export class DiagnosticsModule {}
