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
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { ProjectWorkspaceCollectorService } from '@/modules/manuscripts/core';
import { RegexAstBibtexParser } from '@/modules/manuscripts/citations/domain';

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);
  private readonly knowledgeBase: ErrorKnowledgeBase;
  private readonly logAnalyzer: CompileLogAnalyzer;
  private readonly syntaxLinter: FastSyntaxLinter;
  private readonly bibParser = new RegexAstBibtexParser();

  constructor(
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional()
    private readonly workspaceCollector?: ProjectWorkspaceCollectorService,
    @Optional()
    knowledgeBase?: ErrorKnowledgeBase,
    @Optional()
    logAnalyzer?: CompileLogAnalyzer,
    @Optional()
    syntaxLinter?: FastSyntaxLinter,
  ) {
    this.knowledgeBase = knowledgeBase ?? new ErrorKnowledgeBase();
    this.logAnalyzer =
      logAnalyzer ?? new CompileLogAnalyzer(this.knowledgeBase);
    this.syntaxLinter =
      syntaxLinter ?? new FastSyntaxLinter(this.knowledgeBase);
  }

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

    if (this.workspaceCollector) {
      await this.workspaceCollector
        .flushProjectWorkspace(projectId)
        .catch(() => []);
    }

    if (this.docstoreService) {
      try {
        const docs = await this.docstoreService.getAllDocs(projectId);

        for (const doc of docs) {
          if (doc.path?.endsWith('.bib')) {
            const rawText = doc.lines?.join('\n') || '';
            const entries = this.bibParser.parse(rawText);
            for (const entry of entries) {
              const rawKey =
                typeof entry.key === 'string'
                  ? entry.key
                  : (entry.key?.value ?? '');
              if (rawKey) knownBibKeys.add(rawKey.trim());
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
    return this.knowledgeBase.requireByCode(code).toJSON();
  }

  /**
   * List all error explanation rules in the knowledge base.
   */
  public listAllRules(): ErrorExplanationDto[] {
    return this.knowledgeBase
      .getAllRules()
      .map((r) => r.toJSON() as ErrorExplanationDto);
  }
}
