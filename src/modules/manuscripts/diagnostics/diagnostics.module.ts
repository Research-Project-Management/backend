/**
 * modules/manuscripts/diagnostics/diagnostics.module.ts
 * NestJS Module for Manuscripts Diagnostics subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticsRepository } from './diagnostics.repository';

// Ports & Adapters
import { LATEX_LOG_PARSER_PORT } from './core/ports/latex-log-parser.port';
import { SYNTAX_LINTER_PORT } from './core/ports/syntax-linter.port';
import { ERROR_EXPLAINER_PORT } from './core/ports/error-explainer.port';

import { KnowledgeBaseExplainerAdapter } from './core/adapters/explainer/knowledge-base-explainer.adapter';
import { TexParenTreeLogParser } from './core/adapters/parser/tex-paren-tree-log.parser';
import { TectonicLogParser } from './core/adapters/parser/tectonic-log.parser';
import { FastSyntaxLinterAdapter } from './core/adapters/linter/fast-syntax-linter.adapter';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

@Module({
  imports: [DocstoreModule],
  controllers: [DiagnosticsController],
  providers: [
    DiagnosticsService,
    DiagnosticsRepository,
    {
      provide: ERROR_EXPLAINER_PORT,
      useExisting: DiagnosticsRepository,
    },
    {
      provide: LATEX_LOG_PARSER_PORT,
      inject: [ERROR_EXPLAINER_PORT],
      useFactory: (explainer: KnowledgeBaseExplainerAdapter) => {
        return new TexParenTreeLogParser(explainer);
      },
    },
    {
      provide: TectonicLogParser,
      inject: [ERROR_EXPLAINER_PORT],
      useFactory: (explainer: KnowledgeBaseExplainerAdapter) => {
        return new TectonicLogParser(explainer);
      },
    },
    {
      provide: SYNTAX_LINTER_PORT,
      inject: [ERROR_EXPLAINER_PORT],
      useFactory: (explainer: KnowledgeBaseExplainerAdapter) => {
        return new FastSyntaxLinterAdapter(explainer);
      },
    },
  ],
  exports: [
    DiagnosticsService,
    DiagnosticsRepository,
    LATEX_LOG_PARSER_PORT,
    SYNTAX_LINTER_PORT,
    ERROR_EXPLAINER_PORT,
  ],
})
export class DiagnosticsModule {}
