/**
 * diagnostics/diagnostics.service.ts
 * Facade Service orchestrating LaTeX Diagnostics, Log Parsing, Linter, and Explanations.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ParseCompileLogUseCase } from './core/use-cases/parse-compile-log.use-case';
import { LintDocumentSyntaxUseCase } from './core/use-cases/lint-document-syntax.use-case';
import { GetErrorExplanationUseCase } from './core/use-cases/get-error-explanation.use-case';
import {
  ParseLogDto,
  LintDocumentDto,
  DiagnosticReportDto,
  ErrorExplanationDto,
} from './dto/diagnostics.dto';
import { DiagnosticReport } from './core/domain/entities/diagnostic-report.entity';

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);

  constructor(
    private readonly parseLogUseCase: ParseCompileLogUseCase,
    private readonly lintSyntaxUseCase: LintDocumentSyntaxUseCase,
    private readonly getExplanationUseCase: GetErrorExplanationUseCase
  ) {}

  /**
   * Parse a raw compilation log and return an enriched diagnostic report.
   */
  public parseCompileLog(dto: ParseLogDto): DiagnosticReportDto {
    const report = this.parseLogUseCase.execute({
      logText: dto.logText,
      defaultFile: dto.defaultFile,
      engine: dto.engine,
    });

    return report.toJSON() as DiagnosticReportDto;
  }

  /**
   * Programmatic API for direct subsystem calls (e.g. from ClsiService compile pipeline).
   */
  public parseLogRaw(
    logText: string,
    defaultFile = 'main.tex',
    engine = 'pdflatex'
  ): DiagnosticReport {
    return this.parseLogUseCase.execute({
      logText,
      defaultFile,
      engine,
    });
  }

  /**
   * Statically lint a document source in memory.
   */
  public lintDocument(dto: LintDocumentDto): DiagnosticReportDto {
    const report = this.lintSyntaxUseCase.execute({
      source: dto.source,
      filename: dto.filename,
    });

    return report.toJSON() as DiagnosticReportDto;
  }

  /**
   * Look up detailed explanation and remedy for an error code.
   */
  public getErrorExplanation(code: string): ErrorExplanationDto {
    const explanation = this.getExplanationUseCase.execute(code);
    return explanation.toJSON() as ErrorExplanationDto;
  }

  /**
   * List all error explanation rules in the knowledge base.
   */
  public listAllRules(): ErrorExplanationDto[] {
    const rules = this.getExplanationUseCase.listRules();
    return rules.map((r) => r.toJSON() as ErrorExplanationDto);
  }
}
