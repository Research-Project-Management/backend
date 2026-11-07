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
  SyntaxLinter,
  ErrorKnowledgeBase,
} from './domain';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { WorkspaceCollectorService } from '@/modules/pages/core';
import { BibtexParser } from '@/modules/pages/citations/domain';

const BIBITEM_KEY_RE = /\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g;
const LABEL_KEY_RE = /\\label\{([^}]+)\}/g;

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);
  private readonly knowledgeBase: ErrorKnowledgeBase;
  private readonly logAnalyzer: CompileLogAnalyzer;
  private readonly syntaxLinter: SyntaxLinter;
  private readonly bibParser = new BibtexParser();

  constructor(
    @Optional()
    private readonly docstoreService?: DocstoreService,
    @Optional()
    private readonly workspaceCollector?: WorkspaceCollectorService,
    @Optional()
    knowledgeBase?: ErrorKnowledgeBase,
    @Optional()
    logAnalyzer?: CompileLogAnalyzer,
    @Optional()
    syntaxLinter?: SyntaxLinter,
  ) {
    this.knowledgeBase = knowledgeBase ?? new ErrorKnowledgeBase();
    this.logAnalyzer =
      logAnalyzer ?? new CompileLogAnalyzer(this.knowledgeBase);
    this.syntaxLinter =
      syntaxLinter ?? new SyntaxLinter(this.knowledgeBase);
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
   * Statically lint a document source in memory (or against explicit knownBibKeys/knownLabels).
   */
  public lintDocument(dto: LintDocumentDto): DiagnosticReportDto {
    const source = dto.source ?? dto.content ?? '';
    const knownBibKeys =
      Array.isArray(dto.knownBibKeys) && dto.knownBibKeys.length > 0
        ? new Set(dto.knownBibKeys.flatMap((k) => [k, k.toLowerCase()]))
        : undefined;
    const knownLabels =
      Array.isArray(dto.knownLabels) && dto.knownLabels.length > 0
        ? new Set(dto.knownLabels)
        : undefined;

    const report = this.syntaxLinter.lintToReport(
      source,
      dto.filename,
      knownBibKeys,
      knownLabels,
    );
    return report.toJSON();
  }

  private extractInlineTexSymbols(
    rawText: string,
    knownBibKeys: Set<string>,
    knownLabels: Set<string>,
  ): void {
    for (const bm of rawText.matchAll(BIBITEM_KEY_RE)) {
      const k = bm[1]?.trim();
      if (k) {
        knownBibKeys.add(k);
        knownBibKeys.add(k.toLowerCase());
      }
    }
    for (const lm of rawText.matchAll(LABEL_KEY_RE)) {
      const l = lm[1]?.trim();
      if (l) {
        knownLabels.add(l);
      }
    }
  }

  private collectProjectKnownSymbols(
    docs: Array<{ _id?: string; path?: string; lines?: string[] }>,
    knownBibKeys: Set<string>,
    knownLabels: Set<string>,
  ): void {
    for (const doc of docs) {
      const lowerPath = (doc.path || '').toLowerCase();
      const rawText = (doc.lines || []).join('\n');

      if (lowerPath.endsWith('.bib')) {
        for (const entry of this.bibParser.parse(rawText)) {
          const rawKey =
            typeof entry.key === 'string'
              ? entry.key
              : (entry.key?.value ?? '');
          const trimmedKey = rawKey.trim();
          if (trimmedKey) {
            knownBibKeys.add(trimmedKey);
            knownBibKeys.add(trimmedKey.toLowerCase());
          }
        }
      } else if (lowerPath.endsWith('.tex') || lowerPath.endsWith('.latex')) {
        this.extractInlineTexSymbols(rawText, knownBibKeys, knownLabels);
      }
    }
  }

  /**
   * Statically lint a single document within a project context, cross-checking
   * \cite{...} and \ref{...} against all project .bib entries, \bibitem definitions,
   * and \label{...} declarations in DocstoreService.
   */
  public async lintProjectDocument(
    projectId: string,
    dto: LintDocumentDto,
  ): Promise<DiagnosticReportDto> {
    const knownBibKeys = new Set<string>(
      (dto.knownBibKeys || []).flatMap((k) => [k, k.toLowerCase()]),
    );
    const knownLabels = new Set<string>(dto.knownLabels || []);

    let sourceText = dto.source ?? dto.content;
    let filename = dto.filename || 'main.tex';

    if (this.workspaceCollector) {
      await this.workspaceCollector
        .flushProjectWorkspace(projectId)
        .catch(() => []);
    }

    if (this.docstoreService) {
      try {
        const docs = await this.docstoreService.getAllDocs(projectId);
        if (dto.docId && sourceText === undefined) {
          const targetDoc = docs.find((d) => d._id === dto.docId);
          if (targetDoc) {
            sourceText = (targetDoc.lines || []).join('\n');
            if (!dto.filename && targetDoc.path) {
              filename = targetDoc.path;
            }
          }
        }
        this.collectProjectKnownSymbols(docs, knownBibKeys, knownLabels);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `lintProjectDocument failed to collect symbols for ${projectId}: ${errorMessage}`,
        );
      }
    }

    const finalSource = sourceText ?? '';
    this.extractInlineTexSymbols(finalSource, knownBibKeys, knownLabels);

    const report = this.syntaxLinter.lintToReport(
      finalSource,
      filename,
      knownBibKeys.size > 0 ? knownBibKeys : undefined,
      knownLabels.size > 0 ? knownLabels : undefined,
    );
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
    const knownLabels = new Set<string>();

    if (this.workspaceCollector) {
      await this.workspaceCollector
        .flushProjectWorkspace(projectId)
        .catch(() => []);
    }

    if (this.docstoreService) {
      try {
        const docs = await this.docstoreService.getAllDocs(projectId);
        this.collectProjectKnownSymbols(docs, knownBibKeys, knownLabels);

        for (const doc of docs) {
          if (doc.path?.endsWith('.tex')) {
            const rawText = doc.lines?.join('\n') || '';
            const report = this.syntaxLinter.lintToReport(
              rawText,
              doc.path,
              knownBibKeys,
              knownLabels,
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
