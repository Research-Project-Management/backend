/**
 * diagnostics/diagnostics.module.ts
 * NestJS Module for Manuscripts Diagnostics subsystem.
 */

import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';

// Ports
import { LATEX_LOG_PARSER_PORT } from './core/ports/latex-log-parser.port';
import { SYNTAX_LINTER_PORT } from './core/ports/syntax-linter.port';
import { ERROR_EXPLAINER_PORT } from './core/ports/error-explainer.port';

// Adapters
import { KnowledgeBaseExplainerAdapter } from './core/adapters/explainer/knowledge-base-explainer.adapter';
import { TexParenTreeLogParser } from './core/adapters/parser/tex-paren-tree-log.parser';
import { TectonicLogParser } from './core/adapters/parser/tectonic-log.parser';
import { FastSyntaxLinterAdapter } from './core/adapters/linter/fast-syntax-linter.adapter';

// Use Cases
import { ParseCompileLogUseCase } from './core/use-cases/parse-compile-log.use-case';
import { LintDocumentSyntaxUseCase } from './core/use-cases/lint-document-syntax.use-case';
import { GetErrorExplanationUseCase } from './core/use-cases/get-error-explanation.use-case';

@Module({
  controllers: [DiagnosticsController],
  providers: [
    // 1. Explainer Adapter
    {
      provide: ERROR_EXPLAINER_PORT,
      useClass: KnowledgeBaseExplainerAdapter,
    },

    // 2. Parser Adapters
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

    // 3. Linter Adapter
    {
      provide: SYNTAX_LINTER_PORT,
      inject: [ERROR_EXPLAINER_PORT],
      useFactory: (explainer: KnowledgeBaseExplainerAdapter) => {
        return new FastSyntaxLinterAdapter(explainer);
      },
    },

    // 4. Inbound Use Cases
    {
      provide: ParseCompileLogUseCase,
      inject: [LATEX_LOG_PARSER_PORT, TectonicLogParser],
      useFactory: (
        defaultParser: TexParenTreeLogParser,
        tectonicParser: TectonicLogParser
      ) => {
        return new ParseCompileLogUseCase(defaultParser, tectonicParser);
      },
    },
    {
      provide: LintDocumentSyntaxUseCase,
      inject: [SYNTAX_LINTER_PORT],
      useFactory: (linter: FastSyntaxLinterAdapter) => {
        return new LintDocumentSyntaxUseCase(linter);
      },
    },
    {
      provide: GetErrorExplanationUseCase,
      inject: [ERROR_EXPLAINER_PORT],
      useFactory: (explainer: KnowledgeBaseExplainerAdapter) => {
        return new GetErrorExplanationUseCase(explainer);
      },
    },

    // 5. Facade Service
    DiagnosticsService,
  ],
  exports: [
    DiagnosticsService,
    LATEX_LOG_PARSER_PORT,
    SYNTAX_LINTER_PORT,
    ERROR_EXPLAINER_PORT,
  ],
})
export class DiagnosticsModule {}
