/**
 * modules/manuscripts/diagnostics/diagnostics.service.ts
 * Deep module service orchestrating LaTeX Diagnostics, Log Parsing, Linter, and Explanations.
 * Executes directly via pure domain CompileLogAnalyzer, FastSyntaxLinter, and DiagnosticsRepository.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ParseLogDto,
  LintDocumentDto,
  DiagnosticReportDto,
  ErrorExplanationDto,
  AutoFixResponseDto,
} from './dto/diagnostics.dto';
import {
  DiagnosticReport,
  DiagnosticItem,
  CompileLogAnalyzer,
  FastSyntaxLinter,
  ErrorKnowledgeBase,
} from './domain';
import { DiagnosticsRepository } from './diagnostics.repository';

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);
  private readonly knowledgeBase = new ErrorKnowledgeBase();
  private readonly logAnalyzer = new CompileLogAnalyzer(this.knowledgeBase);
  private readonly syntaxLinter = new FastSyntaxLinter(this.knowledgeBase);

  constructor(
    @Optional()
    private readonly repository?: DiagnosticsRepository,
  ) {}

  /**
   * Parse a raw compilation log and return an enriched diagnostic report.
   */
  public parseCompileLog(dto: ParseLogDto): DiagnosticReportDto {
    const report = this.parseLogRaw(dto.logText, dto.defaultFile, dto.engine);
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
    return this.logAnalyzer.analyzeLog(logText, defaultFile, engine);
  }

  /**
   * Statically lint a document source in memory.
   */
  public lintDocument(dto: LintDocumentDto): DiagnosticReportDto {
    const report = this.syntaxLinter.lintToReport(dto.source, dto.filename);
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

    if (this.repository) {
      try {
        const docs = await this.repository.getProjectDocuments(projectId);

        for (const doc of docs) {
          if (doc.path?.endsWith('.bib')) {
            const rawText = doc.lines?.join('\n') || '';
            const keyMatches = rawText.matchAll(/@[a-zA-Z]+\s*\{\s*([^,\s]+)/g);
            for (const km of keyMatches) {
              if (km[1]) knownBibKeys.add(km[1].trim());
            }
          }
        }

        for (const doc of docs) {
          if (doc.path?.endsWith('.tex')) {
            const rawText = doc.lines?.join('\n') || '';
            const report = this.syntaxLinter.lintToReport(
              rawText,
              doc.path,
              knownBibKeys,
            );
            allItems.push(...report.items);
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `lintProject failed for ${projectId}: ${errorMessage}`,
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
    const res = this.syntaxLinter.autoFix(source);
    return {
      isFixed: res.isFixed,
      fixedSource: res.fixedSource,
      appliedFixes: res.appliedFixes,
    };
  }

  /**
   * Look up detailed explanation and remedy for an error code.
   */
  public getErrorExplanation(code: string): ErrorExplanationDto {
    if (this.repository) {
      return this.repository.requireByCode(code).toJSON();
    }
    return this.knowledgeBase.requireByCode(code).toJSON();
  }

  /**
   * List all error explanation rules in the knowledge base.
   */
  public listAllRules(): ErrorExplanationDto[] {
    const rules = this.repository
      ? this.repository.getAllRules()
      : this.knowledgeBase.getAllRules();
    return rules.map((r) => r.toJSON() as ErrorExplanationDto);
  }
}
