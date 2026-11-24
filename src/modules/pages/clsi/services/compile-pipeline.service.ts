/**
 * modules/pages/clsi/services/compile-pipeline.service.ts
 * Coordinates the 5-step LaTeX compilation pipeline across the real engine seam
 * (LatexmkEngine), sandbox runners (LocalProcessRunner vs DockerSandboxRunner),
 * health check probes, and workspace repository, using pure in-process domain logic.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  BibLogInput,
  CompileLogMeta,
  CompileOutcome,
  CompileValidationIssue,
  DiagnosticsSummary,
  IWorkspaceManager,
  WorkspaceFile,
  ILatexEngine,
  ILogParser,
  CompilerDiagnostic,
  DiscoveredOutputFile,
  IOutputFileFinder,
} from '../domain/clsi.ports';
import {
  ProjectLockManager,
  OutputFileFinder,
} from '../repositories/workspace.repository';
import { TexEngineDetector } from '../domain/tex-engine.detector';
import { CompileLogAnalyzer } from '../domain/log-parser/compile-log.analyzer';
import { BibBackendDetector } from '../domain/bib-backend.detector';
import { DraftModeManager } from '../domain/draft-mode.manager';
import { SafePath } from '../domain/safe-path';
import {
  BaseLatexEngine,
  LatexmkEngine,
  hasControlChar,
} from './latexmk.engine';
import {
  ClsiHealthCheck,
  type BinaryStatus,
  type ClsiHealthReport,
} from './clsi-health.check';

export { killProcessGroup, Watchdog } from './sandbox/process-watchdog';
export { LocalProcessRunner } from './sandbox/local-process.runner';
export { DockerSandboxRunner } from './sandbox/docker-sandbox.runner';
export { BaseLatexEngine, LatexmkEngine, ClsiHealthCheck };
export type { BinaryStatus, ClsiHealthReport };

export {
  MAX_PARSE_LOG_BYTES,
  MAX_BIB_LOG_BYTES,
  MAX_INLINE_LOG_BYTES,
  readBoundedLogFile,
  boundInlineLogText,
} from './clsi-log.helper';
import {
  MAX_PARSE_LOG_BYTES,
  MAX_BIB_LOG_BYTES,
  readBoundedLogFile,
  boundInlineLogText,
} from './clsi-log.helper';

export interface BuildStateRecord {
  success: boolean;
  mainFile: string;
  engine: string;
  draft: boolean;
  timestamp: number;
}

export interface CompilePipelineRequest {
  projectId?: string;
  mainFile?: string;
  engine?: string;
  texLiveVersion?: string;
  draft?: boolean;
  syntaxOnly?: boolean;
  force?: boolean;
  stopOnFirstError?: boolean;
  timeoutMs?: number;
  source?: string;
  files?: Record<string, string | Buffer>;
  resources?: Array<{ path: string; content?: string; hash?: string }>;
  signal?: AbortSignal;
  onLogChunk?: (chunk: string) => void;
}

export type CompilePipelineResult =
  | {
      success: true;
      status: 'success';
      outcome?: CompileOutcome;
      pdf: string;
      pdfArtifactUrl?: string;
      synctex?: string;
      synctexArtifactUrl?: string;
      synctexAvailable?: boolean;
      pdfSizeBytes?: number;
      logs: string;
      logMeta?: CompileLogMeta;
      diagnostics?: CompilerDiagnostic[];
      diagnosticsSummary?: DiagnosticsSummary;
      outputFiles?: DiscoveredOutputFile[];
      validationIssues?: CompileValidationIssue[];
      durationMs: number;
      timedOut?: boolean;
    }
  | {
      success: false;
      status: 'failure';
      outcome?: CompileOutcome;
      error: string;
      pdf?: string;
      synctex?: string;
      logs: string;
      logMeta?: CompileLogMeta;
      diagnostics?: CompilerDiagnostic[];
      diagnosticsSummary?: DiagnosticsSummary;
      outputFiles?: DiscoveredOutputFile[];
      validationIssues?: CompileValidationIssue[];
      durationMs: number;
      timedOut?: boolean;
    };

export class CompilePipeline {
  private readonly logger = new Logger(CompilePipeline.name);

  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly latexmkEngine: ILatexEngine,
    private readonly logParser: ILogParser = new CompileLogAnalyzer(),
    private readonly projectLockManager: ProjectLockManager = new ProjectLockManager(),
    private readonly outputFileFinder: IOutputFileFinder = new OutputFileFinder(),
  ) {}

  public async runWithProjectLock<T>(
    projectId: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const resolvedId = projectId || 'default-project';
    const scratchDir = this.workspace.getScratchDir(resolvedId);
    return this.projectLockManager.runWithLock(resolvedId, scratchDir, action, {
      signal,
    });
  }

  public async execute(
    dto: CompilePipelineRequest,
  ): Promise<CompilePipelineResult> {
    const startTime = Date.now();
    const projectId =
      (dto as { spaceId?: string }).spaceId ||
      dto.projectId ||
      'default-project';
    const cleanRelPath = (p: string) =>
      p
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');

    let mainFile = dto.mainFile ? cleanRelPath(dto.mainFile) : '';
    if (
      mainFile &&
      (mainFile.startsWith('-') ||
        mainFile.includes('..') ||
        hasControlChar(mainFile))
    ) {
      throw new BadRequestException(
        `Invalid or unsafe mainFile path: "${dto.mainFile}"`,
      );
    }

    if (!mainFile && dto.files) {
      const textFiles: Record<string, string> = {};
      for (const [k, v] of Object.entries(dto.files)) {
        if (typeof v === 'string') textFiles[k] = v;
      }
      mainFile = TexEngineDetector.detectMainFile(textFiles) || 'main.tex';
    } else if (!mainFile) {
      mainFile = 'main.tex';
    }

    mainFile = cleanRelPath(mainFile);
    if (
      !mainFile ||
      mainFile.startsWith('-') ||
      mainFile.includes('..') ||
      hasControlChar(mainFile)
    ) {
      mainFile = 'main.tex';
    }
    if (!mainFile.endsWith('.tex')) {
      mainFile = `${mainFile}.tex`;
    }

    const rawMain =
      dto.source ||
      (dto.files
        ? (dto.files[mainFile] ?? dto.files[`/${mainFile}`])
        : undefined) ||
      '';
    let mainSource = Buffer.isBuffer(rawMain)
      ? rawMain.toString('utf8')
      : rawMain;

    const engineDetect = TexEngineDetector.detect(mainSource, dto.engine);
    const resolvedEngine = engineDetect.engine;
    const shellEscapeAdvisories = engineDetect.shellEscapeAdvisories || [];

    if (!dto.mainFile && engineDetect.mainFileHint) {
      const hinted = cleanRelPath(engineDetect.mainFileHint);
      if (
        hinted &&
        !hinted.startsWith('-') &&
        !hinted.includes('..') &&
        !hasControlChar(hinted)
      ) {
        mainFile = hinted.endsWith('.tex') ? hinted : `${hinted}.tex`;
      }
    }

    if (dto.draft || dto.syntaxOnly) {
      const draftApp = DraftModeManager.apply(mainSource, {
        draft: dto.draft,
        syntaxOnly: dto.syntaxOnly,
      });
      if (draftApp.isModified) {
        mainSource = draftApp.source;
      }
    }

    const workspaceFiles: WorkspaceFile[] = [];

    if (mainSource) {
      workspaceFiles.push({
        path: mainFile,
        content: mainSource,
      });
    }

    if (dto.files) {
      for (const [filePath, content] of Object.entries(dto.files)) {
        const cleanPath = cleanRelPath(filePath);
        if (cleanPath === mainFile) continue;
        workspaceFiles.push({
          path: cleanPath,
          content,
        });
      }
    }

    if (dto.resources) {
      for (const res of dto.resources) {
        if (res.content !== undefined) {
          const cleanPath = cleanRelPath(res.path);
          if (cleanPath === mainFile) continue;
          workspaceFiles.push({
            path: cleanPath,
            content: res.content,
            hash: res.hash,
          });
        }
      }
    }

    if (dto.signal?.aborted) {
      return {
        success: false,
        status: 'failure',
        outcome: 'terminated',
        error: 'Compilation superseded or cancelled',
        logs: '',
        durationMs: 0,
      };
    }

    if (workspaceFiles.length === 0) {
      const msg = `Main TeX document "${mainFile}" is missing or empty.`;
      return {
        success: false,
        status: 'failure',
        outcome: 'validation-problems',
        error: msg,
        logs: '',
        diagnostics: [],
        validationIssues: [
          {
            code: 'mainFile',
            mainFile,
            availableTexFiles: [],
            message: msg,
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const scratchDir = this.workspace.getScratchDir(projectId);
    const inputFiles = workspaceFiles.map((f) => f.path);

    try {
      return await this.projectLockManager.runWithLock(
        projectId,
        scratchDir,
        async () => {
          const syncStats = await this.workspace.syncFiles(
            projectId,
            workspaceFiles,
          );

          const pdfPath = path.join(scratchDir, 'output.pdf');
          const buildStatePath = path.join(
            scratchDir,
            '.clsi-build-state.json',
          );

          let prevBuildState: BuildStateRecord | null = null;
          try {
            const stateRaw = await fs.readFile(buildStatePath, 'utf8');
            prevBuildState = JSON.parse(stateRaw) as BuildStateRecord;
          } catch {
            prevBuildState = null;
          }

          if (
            syncStats.written === 0 &&
            syncStats.deleted === 0 &&
            !dto.syntaxOnly &&
            !dto.force &&
            prevBuildState?.success === true &&
            prevBuildState.mainFile === mainFile &&
            prevBuildState.engine === resolvedEngine &&
            prevBuildState.draft === (dto.draft ?? false)
          ) {
            try {
              const pdfStat = await fs.stat(pdfPath);
              if (pdfStat.size > 0) {
                const harvested = await this.harvestCompileArtifacts({
                  scratchDir,
                  projectId,
                  mainFile,
                  inputFiles,
                  stopOnFirstError: dto.stopOnFirstError ?? false,
                  fallbackLogs:
                    '[CLSI Cache] Build up to date: workspace unchanged.',
                });

                if (harvested.pdfBase64) {
                  dto.onLogChunk?.(
                    '[CLSI Cache] Build up to date: 0 source files modified. Returning cached output.',
                  );

                  return {
                    success: true,
                    status: 'success',
                    outcome: 'success',
                    pdf: harvested.pdfBase64,
                    synctex: harvested.synctexBase64 || undefined,
                    logs: harvested.logs,
                    logMeta: harvested.logMeta,
                    diagnostics:
                      harvested.diagnostics.length > 0
                        ? harvested.diagnostics
                        : undefined,
                    diagnosticsSummary: harvested.summary,
                    outputFiles: harvested.discoveredFiles,
                    durationMs: Date.now() - startTime,
                  };
                }
              }
            } catch {
              // Cache miss or missing file: proceed to standard compile
            }
          }

          if (
            prevBuildState &&
            (prevBuildState.engine !== resolvedEngine ||
              prevBuildState.mainFile !== mainFile)
          ) {
            await this.workspace.cleanAuxBuildCache?.(projectId);
          }

          const shouldForceLatexmk = Boolean(
            dto.force ||
            dto.syntaxOnly ||
            !prevBuildState?.success ||
            prevBuildState.engine !== resolvedEngine ||
            prevBuildState.mainFile !== mainFile ||
            prevBuildState.draft !== (dto.draft ?? false) ||
            (syncStats.written === 0 && syncStats.deleted === 0),
          );

          await this.workspace.purgeExtraneousFiles(projectId, inputFiles);

          const bibBackend = await BibBackendDetector.detect(
            mainSource,
            scratchDir,
            engineDetect.bibProgramHint,
          );
          const userLatexmkFile = workspaceFiles.find(
            (f) => f.path === '.latexmkrc' || f.path === 'latexmkrc',
          );

          await BibBackendDetector.writeLatexmkrc(
            scratchDir,
            {
              engine: resolvedEngine,
              bibBackend,
              shellEscape: false,
            },
            userLatexmkFile?.content
              ? Buffer.isBuffer(userLatexmkFile.content)
                ? userLatexmkFile.content.toString('utf8')
                : String(userLatexmkFile.content)
              : undefined,
          );

          const resolvedRunner =
            await this.resolveAvailableEngine(resolvedEngine);
          if (!resolvedRunner) {
            const errorMsg =
              'No supported TeX engine (latexmk/pdflatex) was found in PATH or sandbox runner. Please install TeX Live (latexmk), or configure CLSI_URL / Docker runner.';
            return {
              success: false,
              status: 'failure',
              outcome: 'clsi-unavailable',
              error: errorMsg,
              logs: errorMsg,
              diagnostics: [],
              durationMs: Date.now() - startTime,
            };
          }

          const { engineToUse, compilerFlag } = resolvedRunner;
          const timeoutMs = dto.timeoutMs || 240000;
          const stopOnFirstError = dto.stopOnFirstError ?? false;

          const engineResult = await engineToUse.compile(
            {
              cwd: scratchDir,
              mainFile,
              timeoutMs,
              stopOnFirstError,
              draft: dto.draft ?? false,
              syntaxOnly: dto.syntaxOnly ?? false,
              force: shouldForceLatexmk,
              compilerOverride: compilerFlag,
              signal: dto.signal,
              onLogChunk: dto.onLogChunk,
            },
            compilerFlag,
          );

          if (dto.signal?.aborted) {
            return {
              success: false,
              status: 'failure',
              outcome: 'terminated',
              error: 'Compilation superseded or cancelled',
              logs: '',
              durationMs: Date.now() - startTime,
            };
          }

          const durationMs = Date.now() - startTime;
          let fallbackLogs = engineResult.stdout || '';
          if (engineResult.stderr) {
            fallbackLogs += `\n${engineResult.stderr}`;
          }

          const harvested = await this.harvestCompileArtifacts({
            scratchDir,
            projectId,
            mainFile,
            inputFiles,
            stopOnFirstError,
            fallbackLogs,
            shellEscapeAdvisories,
          });

          const writeBuildState = async (success: boolean) => {
            try {
              await fs.writeFile(
                buildStatePath,
                JSON.stringify({
                  success,
                  mainFile,
                  engine: resolvedEngine,
                  draft: dto.draft ?? false,
                  timestamp: Date.now(),
                } satisfies BuildStateRecord),
                'utf8',
              );
            } catch {
              // Build state cache write failure is non-fatal
            }
          };

          if (engineResult.pdfGenerated && harvested.pdfBase64) {
            const hasErrors = harvested.summary.totalErrors > 0;
            await writeBuildState(!hasErrors);

            if (hasErrors) {
              return {
                success: false,
                status: 'failure',
                outcome:
                  stopOnFirstError && engineResult.exitCode !== 0
                    ? 'stopped-on-first-error'
                    : 'failure',
                error:
                  harvested.diagnostics.find((d) => d.severity === 'error')
                    ?.message || 'LaTeX compilation completed with errors',
                pdf: harvested.pdfBase64,
                synctex: harvested.synctexBase64 || undefined,
                logs: harvested.logs,
                logMeta: harvested.logMeta,
                diagnostics: harvested.diagnostics,
                diagnosticsSummary: harvested.summary,
                outputFiles: harvested.discoveredFiles,
                durationMs,
              };
            }

            return {
              success: true,
              status: 'success',
              outcome: 'success',
              pdf: harvested.pdfBase64,
              synctex: harvested.synctexBase64 || undefined,
              logs: harvested.logs,
              logMeta: harvested.logMeta,
              diagnostics:
                harvested.diagnostics.length > 0
                  ? harvested.diagnostics
                  : undefined,
              diagnosticsSummary: harvested.summary,
              outputFiles: harvested.discoveredFiles,
              durationMs,
            };
          }

          const outcome: CompileOutcome = engineResult.timedOut
            ? 'timedout'
            : (engineResult as { aborted?: boolean }).aborted ||
                dto.signal?.aborted
              ? 'terminated'
              : stopOnFirstError && engineResult.exitCode !== 0
                ? 'stopped-on-first-error'
                : 'failure';

          if (outcome !== 'terminated') {
            await writeBuildState(false);
          }

          return {
            success: false,
            status: 'failure',
            outcome,
            error:
              harvested.diagnostics.find((d) => d.severity === 'error')
                ?.message ||
              (outcome === 'timedout'
                ? `Compilation timed out after ${timeoutMs}ms`
                : 'LaTeX compilation failed to produce a PDF'),
            pdf: harvested.pdfBase64 || undefined,
            synctex: harvested.synctexBase64 || undefined,
            logs: harvested.logs,
            logMeta: harvested.logMeta,
            diagnostics:
              harvested.diagnostics.length > 0
                ? harvested.diagnostics
                : undefined,
            diagnosticsSummary: harvested.summary,
            outputFiles: harvested.discoveredFiles,
            durationMs,
            timedOut: engineResult.timedOut,
          };
        },
        { signal: dto.signal },
      );
    } catch (err: unknown) {
      const isAborted =
        Boolean(dto.signal?.aborted) ||
        (err as { name?: string })?.name === 'AbortError';
      const message = err instanceof Error ? err.message : String(err);
      if (isAborted) {
        return {
          success: false,
          status: 'failure',
          outcome: 'terminated',
          error: 'Compilation superseded or cancelled',
          logs: '',
          durationMs: Date.now() - startTime,
        };
      }
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `CompilePipeline execution error for project ${projectId}: ${message}`,
        stack,
      );
      return {
        success: false,
        status: 'failure',
        outcome: 'failure',
        error: message || 'Compilation execution failed',
        logs: message || 'Compilation execution failed',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Chain of Responsibility / Fallback Strategy: Resolves primary or secondary TeX engine.
   */
  private async resolveAvailableEngine(
    preferred: 'pdflatex' | 'xelatex' | 'lualatex',
  ): Promise<{
    engineToUse: ILatexEngine;
    compilerFlag: 'pdflatex' | 'xelatex' | 'lualatex';
  } | null> {
    const engineToUse: ILatexEngine = this.latexmkEngine;
    let compilerFlag: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex';

    if (preferred === 'xelatex') {
      compilerFlag = 'xelatex';
    } else if (preferred === 'lualatex') {
      compilerFlag = 'lualatex';
    }

    if (await engineToUse.isAvailable()) {
      return { engineToUse, compilerFlag };
    }

    return null;
  }

  /**
   * Collector / Harvester Pattern: Consolidates PDF, SyncTeX, Log, Diagnostics, and Output File
   * collection across both Cache-Hit and Full-Compile execution paths.
   */
  private async harvestCompileArtifacts(params: {
    scratchDir: string;
    projectId: string;
    mainFile: string;
    inputFiles: string[];
    stopOnFirstError?: boolean;
    fallbackLogs?: string;
    shellEscapeAdvisories?: string[];
  }): Promise<{
    pdfBase64: string;
    synctexBase64: string;
    logs: string;
    logMeta: CompileLogMeta;
    diagnostics: CompilerDiagnostic[];
    summary: DiagnosticsSummary;
    discoveredFiles: DiscoveredOutputFile[];
  }> {
    const {
      scratchDir,
      mainFile,
      inputFiles,
      stopOnFirstError = false,
      fallbackLogs = '',
      shellEscapeAdvisories = [],
    } = params;

    const discoveredFiles = await this.outputFileFinder.find(
      scratchDir,
      inputFiles,
    );

    const readSafeFile = async (relName: string): Promise<Buffer | null> => {
      try {
        const safePath = await SafePath.assertSafeWorkspacePath(
          scratchDir,
          relName,
        );
        const stat = await fs.lstat(safePath);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        return await fs.readFile(safePath);
      } catch {
        return null;
      }
    };

    let pdfBase64 = '';
    const pdfBuffer = await readSafeFile('output.pdf');
    if (pdfBuffer) {
      pdfBase64 = pdfBuffer.toString('base64');
    }

    let parseTexLog = fallbackLogs;
    let rawLogSizeBytes = Buffer.byteLength(fallbackLogs || '', 'utf8');
    try {
      const safeLogPath = await SafePath.assertSafeWorkspacePath(
        scratchDir,
        'output.log',
      );
      const boundedTex = await readBoundedLogFile(
        safeLogPath,
        MAX_PARSE_LOG_BYTES,
        256 * 1024,
      );
      if (boundedTex && boundedTex.sizeBytes > 0) {
        parseTexLog = boundedTex.content;
        rawLogSizeBytes = boundedTex.sizeBytes;
      }
    } catch {
      // keep fallbackLogs
    }

    const blgNames = new Set<string>(['output.blg']);
    for (const file of discoveredFiles) {
      if (file.path.toLowerCase().endsWith('.blg')) {
        blgNames.add(file.path);
      }
    }
    const bibLogs: BibLogInput[] = [];
    for (const blgName of blgNames) {
      try {
        const safeBlgPath = await SafePath.assertSafeWorkspacePath(
          scratchDir,
          blgName,
        );
        const boundedBib = await readBoundedLogFile(
          safeBlgPath,
          MAX_BIB_LOG_BYTES,
          64 * 1024,
        );
        if (boundedBib && boundedBib.content) {
          bibLogs.push({ filename: blgName, content: boundedBib.content });
        }
      } catch {
        // skip unreadable/missing blg
      }
    }

    let synctexBase64 = '';
    const synctexGzBuffer = await readSafeFile('output.synctex.gz');
    if (synctexGzBuffer) {
      synctexBase64 = synctexGzBuffer.toString('base64');
    } else {
      const synctexPlainBuffer = await readSafeFile('output.synctex');
      if (synctexPlainBuffer) {
        synctexBase64 = synctexPlainBuffer.toString('base64');
      }
    }

    const parseResult = this.logParser.parseWithSummary
      ? this.logParser.parseWithSummary(parseTexLog, mainFile, {
          bibLogs,
          stopOnFirstError,
        })
      : (() => {
          const parsed = this.logParser.parse(parseTexLog, mainFile, {
            bibLogs,
            stopOnFirstError,
          });
          return {
            diagnostics: parsed,
            summary: {
              totalErrors: parsed.filter((d) => d.severity === 'error').length,
              totalWarnings: parsed.filter((d) => d.severity === 'warning')
                .length,
              totalBadboxes: parsed.filter(
                (d) => d.severity === 'badbox' || d.category === 'badbox',
              ).length,
              suppressedCascadeCount: 0,
              truncated: false,
            },
          };
        })();

    const diagnostics = [...parseResult.diagnostics];
    if (shellEscapeAdvisories.length > 0) {
      for (const adv of shellEscapeAdvisories) {
        diagnostics.push({
          file: mainFile,
          line: null,
          message: `Document references '${adv}' which historically required shell-escape. Shell-escape is strictly disabled in the Flux isolated compile sandbox for security. If compiling fails, consider native LaTeX alternatives (e.g. listings package instead of minted).`,
          severity: 'info',
          source: 'system',
          code: 'SHELL_ESCAPE_ADVISORY',
        });
      }
    }

    const inlineBounded = boundInlineLogText(parseTexLog, rawLogSizeBytes);
    const logMeta: CompileLogMeta = {
      sizeBytes: inlineBounded.sizeBytes,
      truncated: inlineBounded.truncated,
      ...(bibLogs.length > 0
        ? { bibLogFiles: bibLogs.map((b) => b.filename) }
        : {}),
    };

    return {
      pdfBase64,
      synctexBase64,
      logs: inlineBounded.text,
      logMeta,
      diagnostics,
      summary: parseResult.summary,
      discoveredFiles,
    };
  }
}
