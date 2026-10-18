/**
 * modules/manuscripts/diagnostics/diagnostics.module.ts
 * NestJS Module for Manuscripts Diagnostics subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { DiagnosticsController } from './diagnostics.controller';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticsRepository } from './diagnostics.repository';
import {
  LATEX_LOG_PARSER_PORT,
  SYNTAX_LINTER_PORT,
  ERROR_EXPLAINER_PORT,
  CompileLogAnalyzer,
  FastSyntaxLinter,
} from './domain';
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
      inject: [DiagnosticsRepository],
      useFactory: (repo: DiagnosticsRepository) => {
        const analyzer = new CompileLogAnalyzer(repo);
        return {
          parse: (logText: string, defaultFile?: string) =>
            analyzer.parseTexParenTreeLog(logText, defaultFile),
        };
      },
    },
    {
      provide: SYNTAX_LINTER_PORT,
      inject: [DiagnosticsRepository],
      useFactory: (repo: DiagnosticsRepository) => {
        return new FastSyntaxLinter(repo);
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
