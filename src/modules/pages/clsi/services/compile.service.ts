/**
 * modules/pages/clsi/services/compile.service.ts
 * Coordinates the 5-step LaTeX compilation pipeline across the real engine seam
 * (LatexmkEngine), sandbox runners (LocalProcessRunner vs DockerSandboxRunner),
 * health check probes, and workspace repository, using pure in-process domain logic.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  BibLogInput,
  BuildStateRecord,
  CompileLogMeta,
  CompileOutcome,
  CompileValidationIssue,
  DiagnosticsSummary,
  EngineRunResult,
  IWorkspaceManager,
  WorkspaceFile,
  WorkspaceSyncStats,
  ILatexEngine,
  CompilerDiagnostic,
  DiscoveredOutputFile,
} from '../domain/ports';
import {
  ScratchLockAdapter,
  OutputFileFinder,
} from '../adapters/scratch-disk.adapter';
import {
  TexEngineDetector,
  BibBackendDetector,
  DraftModeManager,
  DEFAULT_COMPILE_TIMEOUT_LIMITS,
} from '../domain/compile.policy';
import { CompileLogParser } from '../domain/log-parser/tex-log.parser';
import { SafePath } from '../domain/path.policy';
import { hasControlChar } from '../adapters/latexmk.adapter';

import {
  MAX_PARSE_LOG_BYTES,
  MAX_BIB_LOG_BYTES,
  readBoundedLogFile,
  boundInlineLogText,
} from '../utils/bounded-log.util';

export type { BuildStateRecord };

const CompileResults = {
  success(params: {
    pdf: string;
    synctex?: string;
    logs: string;
    logMeta?: CompileLogMeta;
    diagnostics?: CompilerDiagnostic[];
    diagnosticsSummary?: DiagnosticsSummary;
    outputFiles?: DiscoveredOutputFile[];
    durationMs: number;
  }): CompilePipelineResult {
    return {
      success: true,
      status: 'success',
      outcome: 'success',
      pdf: params.pdf,
      synctex: params.synctex || undefined,
      logs: params.logs,
      logMeta: params.logMeta,
      diagnostics:
        params.diagnostics && params.diagnostics.length > 0
          ? params.diagnostics
          : undefined,
      diagnosticsSummary: params.diagnosticsSummary,
      outputFiles: params.outputFiles,
      durationMs: params.durationMs,
    };
  },

  failure(params: {
    outcome: CompileOutcome;
    error: string;
    logs: string;
    durationMs: number;
    pdf?: string;
    synctex?: string;
    logMeta?: CompileLogMeta;
    diagnostics?: CompilerDiagnostic[];
    diagnosticsSummary?: DiagnosticsSummary;
    outputFiles?: DiscoveredOutputFile[];
    validationIssues?: CompileValidationIssue[];
    timedOut?: boolean;
  }): CompilePipelineResult {
    return {
      success: false,
      status: 'failure',
      outcome: params.outcome,
      error: params.error,
      logs: params.logs,
      durationMs: params.durationMs,
      ...(params.pdf ? { pdf: params.pdf } : {}),
      ...(params.synctex ? { synctex: params.synctex } : {}),
      ...(params.logMeta ? { logMeta: params.logMeta } : {}),
      ...(params.diagnostics !== undefined
        ? { diagnostics: params.diagnostics }
        : {}),
      ...(params.diagnosticsSummary
        ? { diagnosticsSummary: params.diagnosticsSummary }
        : {}),
      ...(params.outputFiles ? { outputFiles: params.outputFiles } : {}),
      ...(params.validationIssues
        ? { validationIssues: params.validationIssues }
        : {}),
      ...(params.timedOut !== undefined ? { timedOut: params.timedOut } : {}),
    };
  },

  terminated(durationMs: number): CompilePipelineResult {
    return CompileResults.failure({
      outcome: 'terminated',
      error: 'Compilation superseded or cancelled',
      logs: '',
      durationMs,
    });
  },
};

export interface CompilePipelineRequest {
  spaceId?: string;
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

export class CompileService {
  private readonly logger = new Logger(CompileService.name);

  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly latexmkEngine: ILatexEngine,
    private readonly logParser: CompileLogParser = new CompileLogParser(),
    private readonly scratchLock: ScratchLockAdapter = new ScratchLockAdapter(),
    private readonly outputFileFinder: OutputFileFinder = new OutputFileFinder(),
  ) {}

  public async runWithWorkspaceLock<T>(
    spaceId: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const resolvedId = spaceId || 'default-project';
    const scratchDir = this.workspace.getScratchDir(resolvedId);
    return this.scratchLock.runWithLock(resolvedId, scratchDir, action, {
      signal,
    });
  }

  public async execute(
    dto: CompilePipelineRequest,
  ): Promise<CompilePipelineResult> {
    const startTime = Date.now();
    const prepared = this.prepareInputs(dto);

    if (dto.signal?.aborted) {
      return CompileResults.terminated(0);
    }

    if (prepared.workspaceFiles.length === 0) {
      const msg = `Main TeX document "${prepared.mainFile}" is missing or empty.`;
      return CompileResults.failure({
        outcome: 'validation-problems',
        error: msg,
        logs: '',
        diagnostics: [],
        validationIssues: [
          {
            code: 'mainFile',
            mainFile: prepared.mainFile,
            availableTexFiles: [],
            message: msg,
          },
        ],
        durationMs: Date.now() - startTime,
      });
    }

    const scratchDir = this.workspace.getScratchDir(prepared.spaceId);

    try {
      return await this.scratchLock.runWithLock(
        prepared.spaceId,
        scratchDir,
        async () => {
          const syncStats = await this.workspace.syncFiles(
            prepared.spaceId,
            prepared.workspaceFiles,
          );
          const prevBuildState = await this.workspace.readBuildState(
            prepared.spaceId,
          );

          const cached = await this.tryDiskCacheHit({
            dto,
            prepared,
            scratchDir,
            syncStats,
            prevBuildState,
            startTime,
          });
          if (cached) return cached;

          const shouldForceLatexmk = await this.prepareScratchConfig({
            dto,
            prepared,
            scratchDir,
            syncStats,
            prevBuildState,
          });

          const compilerFlag = await this.resolveAvailableEngine(
            prepared.resolvedEngine,
          );
          if (!compilerFlag) {
            const errorMsg =
              'No supported TeX engine (latexmk/pdflatex) was found in PATH or sandbox runner. Please install TeX Live (latexmk), or configure CLSI_URL / Docker runner.';
            return CompileResults.failure({
              outcome: 'clsi-unavailable',
              error: errorMsg,
              logs: errorMsg,
              diagnostics: [],
              durationMs: Date.now() - startTime,
            });
          }

          const timeoutMs =
            dto.timeoutMs || DEFAULT_COMPILE_TIMEOUT_LIMITS.manualMs;
          const stopOnFirstError = dto.stopOnFirstError ?? false;
          const engineResult = await this.latexmkEngine.compile(
            {
              cwd: scratchDir,
              mainFile: prepared.mainFile,
              timeoutMs,
              stopOnFirstError,
              draft: dto.draft ?? false,
              syntaxOnly: dto.syntaxOnly ?? false,
              force: shouldForceLatexmk,
              compilerOverride: compilerFlag,
              texLiveVersion: dto.texLiveVersion,
              signal: dto.signal,
              onLogChunk: dto.onLogChunk,
            },
            compilerFlag,
          );

          if (dto.signal?.aborted) {
            return CompileResults.terminated(Date.now() - startTime);
          }

          return await this.resolveOutcome({
            dto,
            prepared,
            scratchDir,
            engineResult,
            timeoutMs,
            stopOnFirstError,
            durationMs: Date.now() - startTime,
          });
        },
        { signal: dto.signal },
      );
    } catch (err: unknown) {
      const isAborted =
        Boolean(dto.signal?.aborted) ||
        (err as { name?: string })?.name === 'AbortError';
      const message = err instanceof Error ? err.message : String(err);
      if (isAborted) {
        return CompileResults.terminated(Date.now() - startTime);
      }
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `CompileService execution error for space ${prepared.spaceId}: ${message}`,
        stack,
      );
      return CompileResults.failure({
        outcome: 'failure',
        error: message || 'Compilation execution failed',
        logs: message || 'Compilation execution failed',
        durationMs: Date.now() - startTime,
      });
    }
  }

  private prepareInputs(dto: CompilePipelineRequest) {
    const spaceId = dto.spaceId || 'default-space';
    const cleanRelPath = SafePath.normalizeRelPath;

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
      workspaceFiles.push({ path: mainFile, content: mainSource });
    }

    const isForbiddenConfigFile = (relPath: string): boolean => {
      const base = path.posix
        .basename(relPath.replace(/\\/g, '/'))
        .toLowerCase();
      return base === 'latexmkrc' || base === '.latexmkrc';
    };

    if (dto.files) {
      for (const [filePath, content] of Object.entries(dto.files)) {
        const cleanPath = cleanRelPath(filePath);
        if (cleanPath === mainFile || isForbiddenConfigFile(cleanPath)) continue;
        workspaceFiles.push({ path: cleanPath, content });
      }
    }

    return {
      spaceId,
      mainFile,
      mainSource,
      resolvedEngine,
      engineDetect,
      shellEscapeAdvisories,
      workspaceFiles,
      inputFiles: workspaceFiles.map((f) => f.path),
    };
  }

  private async tryDiskCacheHit(params: {
    dto: CompilePipelineRequest;
    prepared: ReturnType<CompileService['prepareInputs']>;
    scratchDir: string;
    syncStats: WorkspaceSyncStats;
    prevBuildState: BuildStateRecord | null;
    startTime: number;
  }): Promise<CompilePipelineResult | null> {
    const { dto, prepared, scratchDir, syncStats, prevBuildState, startTime } =
      params;

    if (
      syncStats.written !== 0 ||
      syncStats.deleted !== 0 ||
      dto.syntaxOnly ||
      dto.force ||
      prevBuildState?.success !== true ||
      prevBuildState.mainFile !== prepared.mainFile ||
      prevBuildState.engine !== prepared.resolvedEngine ||
      prevBuildState.draft !== (dto.draft ?? false)
    ) {
      return null;
    }

    try {
      const pdfStat = await fs.stat(path.join(scratchDir, 'output.pdf'));
      if (pdfStat.size <= 0) return null;

      const harvested = await this.harvestCompileArtifacts({
        scratchDir,
        spaceId: prepared.spaceId,
        mainFile: prepared.mainFile,
        inputFiles: prepared.inputFiles,
        stopOnFirstError: dto.stopOnFirstError ?? false,
        fallbackLogs: '[CLSI Cache] Build up to date: workspace unchanged.',
      });

      if (!harvested.pdfBase64) return null;

      dto.onLogChunk?.(
        '[CLSI Cache] Build up to date: 0 source files modified. Returning cached output.',
      );

      return CompileResults.success({
        pdf: harvested.pdfBase64,
        synctex: harvested.synctexBase64,
        logs: harvested.logs,
        logMeta: harvested.logMeta,
        diagnostics: harvested.diagnostics,
        diagnosticsSummary: harvested.summary,
        outputFiles: harvested.discoveredFiles,
        durationMs: Date.now() - startTime,
      });
    } catch {
      return null;
    }
  }

  private async prepareScratchConfig(params: {
    dto: CompilePipelineRequest;
    prepared: ReturnType<CompileService['prepareInputs']>;
    scratchDir: string;
    syncStats: WorkspaceSyncStats;
    prevBuildState: BuildStateRecord | null;
  }): Promise<boolean> {
    const { dto, prepared, scratchDir, syncStats, prevBuildState } = params;

    if (
      prevBuildState &&
      (prevBuildState.engine !== prepared.resolvedEngine ||
        prevBuildState.mainFile !== prepared.mainFile)
    ) {
      await this.workspace.cleanAuxBuildCache(prepared.spaceId);
    }

    const shouldForceLatexmk = Boolean(
      dto.force ||
        dto.syntaxOnly ||
        !prevBuildState?.success ||
        prevBuildState.engine !== prepared.resolvedEngine ||
        prevBuildState.mainFile !== prepared.mainFile ||
        prevBuildState.draft !== (dto.draft ?? false) ||
        (syncStats.written === 0 && syncStats.deleted === 0),
    );

    await this.workspace.purgeExtraneousFiles(
      prepared.spaceId,
      prepared.inputFiles,
    );

    const bibBackend = await BibBackendDetector.detect(
      prepared.mainSource,
      scratchDir,
      prepared.engineDetect.bibProgramHint,
    );
    const userLatexmkFile = prepared.workspaceFiles.find(
      (f) => f.path === '.latexmkrc' || f.path === 'latexmkrc',
    );

    await BibBackendDetector.writeLatexmkrc(
      scratchDir,
      {
        engine: prepared.resolvedEngine,
        bibBackend,
        shellEscape: false,
      },
      userLatexmkFile?.content
        ? Buffer.isBuffer(userLatexmkFile.content)
          ? userLatexmkFile.content.toString('utf8')
          : String(userLatexmkFile.content)
        : undefined,
    );

    return shouldForceLatexmk;
  }

  private async resolveOutcome(params: {
    dto: CompilePipelineRequest;
    prepared: ReturnType<CompileService['prepareInputs']>;
    scratchDir: string;
    engineResult: EngineRunResult;
    timeoutMs: number;
    stopOnFirstError: boolean;
    durationMs: number;
  }): Promise<CompilePipelineResult> {
    const {
      dto,
      prepared,
      scratchDir,
      engineResult,
      timeoutMs,
      stopOnFirstError,
      durationMs,
    } = params;

    let fallbackLogs = engineResult.stdout || '';
    if (engineResult.stderr) {
      fallbackLogs += `\n${engineResult.stderr}`;
    }

    const harvested = await this.harvestCompileArtifacts({
      scratchDir,
      spaceId: prepared.spaceId,
      mainFile: prepared.mainFile,
      inputFiles: prepared.inputFiles,
      stopOnFirstError,
      fallbackLogs,
      shellEscapeAdvisories: prepared.shellEscapeAdvisories,
    });

    const persistBuildState = (success: boolean) =>
      this.workspace.writeBuildState(prepared.spaceId, {
        success,
        mainFile: prepared.mainFile,
        engine: prepared.resolvedEngine,
        draft: dto.draft ?? false,
        timestamp: Date.now(),
      });

    if (engineResult.pdfGenerated && harvested.pdfBase64) {
      const hasErrors = harvested.summary.totalErrors > 0;
      await persistBuildState(!hasErrors);

      if (hasErrors) {
        return CompileResults.failure({
          outcome:
            stopOnFirstError && engineResult.exitCode !== 0
              ? 'stopped-on-first-error'
              : 'failure',
          error:
            harvested.diagnostics.find((d) => d.severity === 'error')
              ?.message || 'LaTeX compilation completed with errors',
          pdf: harvested.pdfBase64,
          synctex: harvested.synctexBase64,
          logs: harvested.logs,
          logMeta: harvested.logMeta,
          diagnostics: harvested.diagnostics,
          diagnosticsSummary: harvested.summary,
          outputFiles: harvested.discoveredFiles,
          durationMs,
        });
      }

      return CompileResults.success({
        pdf: harvested.pdfBase64,
        synctex: harvested.synctexBase64,
        logs: harvested.logs,
        logMeta: harvested.logMeta,
        diagnostics: harvested.diagnostics,
        diagnosticsSummary: harvested.summary,
        outputFiles: harvested.discoveredFiles,
        durationMs,
      });
    }

    const outcome: CompileOutcome = engineResult.timedOut
      ? 'timedout'
      : (engineResult as { aborted?: boolean }).aborted || dto.signal?.aborted
        ? 'terminated'
        : stopOnFirstError && engineResult.exitCode !== 0
          ? 'stopped-on-first-error'
          : 'failure';

    if (outcome !== 'terminated') {
      await persistBuildState(false);
    }

    return CompileResults.failure({
      outcome,
      error:
        harvested.diagnostics.find((d) => d.severity === 'error')?.message ||
        (outcome === 'timedout'
          ? `Compilation timed out after ${timeoutMs}ms`
          : 'LaTeX compilation failed to produce a PDF'),
      pdf: harvested.pdfBase64,
      synctex: harvested.synctexBase64,
      logs: harvested.logs,
      logMeta: harvested.logMeta,
      diagnostics:
        harvested.diagnostics.length > 0 ? harvested.diagnostics : undefined,
      diagnosticsSummary: harvested.summary,
      outputFiles: harvested.discoveredFiles,
      durationMs,
      timedOut: engineResult.timedOut,
    });
  }

  private async resolveAvailableEngine(
    preferred: 'pdflatex' | 'xelatex' | 'lualatex',
  ): Promise<'pdflatex' | 'xelatex' | 'lualatex' | null> {
    if (!(await this.latexmkEngine.isAvailable())) {
      return null;
    }
    return preferred === 'xelatex' || preferred === 'lualatex'
      ? preferred
      : 'pdflatex';
  }

  /**
   * Collector / Harvester Pattern: Consolidates PDF, SyncTeX, Log, Diagnostics, and Output File
   * collection across both Cache-Hit and Full-Compile execution paths.
   */
  private async harvestCompileArtifacts(params: {
    scratchDir: string;
    spaceId: string;
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

export function enrichUnreachableRemoteFailure(params: {
  pipelineResult: CompilePipelineResult;
  mainFile: string;
  remoteUrl: string | null;
}): CompilePipelineResult {
  const { pipelineResult, remoteUrl } = params;
  if (
    pipelineResult.success ||
    (pipelineResult.outcome !== 'clsi-unavailable' &&
      !pipelineResult.error.includes('No supported TeX engine'))
  ) {
    return pipelineResult;
  }
  const detailedError = `Remote CLSI service at ${remoteUrl} is unreachable (ensure the flux_clsi container is running) and no local TeX Live engine is installed.`;
  return {
    ...pipelineResult,
    outcome: 'clsi-unavailable',
    error: detailedError,
    logs: `${detailedError}\n\n${pipelineResult.logs || ''}`.trim(),
    diagnostics: [],
  };
}
