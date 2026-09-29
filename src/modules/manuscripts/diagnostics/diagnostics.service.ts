/**
 * diagnostics/diagnostics.service.ts
 * Facade Service orchestrating LaTeX Diagnostics, Log Parsing, Linter, and Explanations.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { ParseCompileLogUseCase } from './core/use-cases/parse-compile-log.use-case';
import { LintDocumentSyntaxUseCase } from './core/use-cases/lint-document-syntax.use-case';
import { GetErrorExplanationUseCase } from './core/use-cases/get-error-explanation.use-case';
import {
  ParseLogDto,
  LintDocumentDto,
  DiagnosticReportDto,
  ErrorExplanationDto,
  AutoFixResponseDto,
} from './dto/diagnostics.dto';
import { DiagnosticReport } from './core/domain/entities/diagnostic-report.entity';
import { DiagnosticItem } from './core/domain/entities/diagnostic-item.entity';
import {
  SYNTAX_LINTER_PORT,
  ISyntaxLinterPort,
} from './core/ports/syntax-linter.port';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);

  constructor(
    private readonly parseLogUseCase: ParseCompileLogUseCase,
    private readonly lintSyntaxUseCase: LintDocumentSyntaxUseCase,
    private readonly getExplanationUseCase: GetErrorExplanationUseCase,
    @Optional()
    @Inject(SYNTAX_LINTER_PORT)
    private readonly linter?: ISyntaxLinterPort,
    @Optional()
    private readonly docstoreService?: DocstoreService,
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

    return report.toJSON();
  }

  /**
   * Programmatic API for direct subsystem calls (e.g. from ClsiService compile pipeline).
   */
  public parseLogRaw(
    logText: string,
    defaultFile = 'main.tex',
    engine = 'pdflatex',
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

    return report.toJSON();
  }

  /**
   * Statically lint an entire project:
   * Gathers all .bib citation keys and statically checks all .tex files
   * for unclosed environments, unmatched braces, unescaped characters, and missing citations.
   */
  public async lintProject(projectId: string): Promise<DiagnosticReportDto> {
    const allItems: DiagnosticItem[] = [];
    const knownBibKeys = new Set<string>();

    if (this.docstoreService) {
      try {
        const docs = await this.docstoreService.getAllDocs(projectId);

        // 1. Collect all bib keys
        for (const doc of docs) {
          if (doc.path?.endsWith('.bib')) {
            const rawText = doc.lines?.join('\n') || '';
            const keyMatches = rawText.matchAll(/@[a-zA-Z]+\s*\{\s*([^,\s]+)/g);
            for (const km of keyMatches) {
              if (km[1]) knownBibKeys.add(km[1].trim());
            }
          }
        }

        // 2. Lint all tex files
        for (const doc of docs) {
          if (doc.path?.endsWith('.tex')) {
            const rawText = doc.lines?.join('\n') || '';
            const report = this.lintSyntaxUseCase.execute({
              source: rawText,
              filename: doc.path,
              knownBibKeys,
            });
            allItems.push(...report.items);
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `lintProject failed for ${projectId}: ${err?.message}`,
        );
      }
    }

    const aggregatedReport = new DiagnosticReport({
      items: allItems,
    });
    return aggregatedReport.toJSON();
  }

  /**
   * Pre-compile auto-fixer: Automatically repairs common syntax errors
   * (smart quotes, unescaped _, %, unclosed environments).
   */
  public autoFix(source: string): AutoFixResponseDto {
    if (this.linter && typeof this.linter.autoFix === 'function') {
      const res = this.linter.autoFix(source);
      return {
        isFixed: res.isFixed,
        fixedSource: res.fixedSource,
        appliedFixes: res.appliedFixes,
      };
    }
    return {
      isFixed: false,
      fixedSource: source,
      appliedFixes: [],
    };
  }

  /**
   * Look up detailed explanation and remedy for an error code.
   */
  public getErrorExplanation(code: string): ErrorExplanationDto {
    const explanation = this.getExplanationUseCase.execute(code);
    return explanation.toJSON();
  }

  /**
   * List all error explanation rules in the knowledge base.
   */
  public listAllRules(): ErrorExplanationDto[] {
    const rules = this.getExplanationUseCase.listRules();
    return rules.map((r) => r.toJSON() as ErrorExplanationDto);
  }
}
