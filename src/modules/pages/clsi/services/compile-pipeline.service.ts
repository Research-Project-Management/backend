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
import { CompileLogAnalyzer } from '@/modules/pages/diagnostics/domain';
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
      pdf: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
      timedOut?: boolean;
    }
  | {
      success: false;
      status: 'failure';
      error: string;
      pdf?: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
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

    if (workspaceFiles.length === 0) {
      workspaceFiles.push({
        path: mainFile,
        content: '\\documentclass{article}\n\\begin{document}\n\\end{document}',
      });
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

          if (
            syncStats.written === 0 &&
            syncStats.deleted === 0 &&
            !dto.syntaxOnly &&
            !dto.force
          ) {
            try {
              const stateRaw = await fs.readFile(buildStatePath, 'utf8');
              const buildState = JSON.parse(stateRaw);
              if (
                buildState.success &&
                buildState.mainFile === mainFile &&
                buildState.engine === resolvedEngine &&
                buildState.draft === (dto.draft ?? false)
              ) {
                const pdfStat = await fs.stat(pdfPath);
                if (pdfStat.size > 0) {
                  await this.workspace.purgeExtraneousFiles(
                    projectId,
                    inputFiles,
                  );
                  const harvested = await this.harvestCompileArtifacts({
                    scratchDir,
                    projectId,
                    mainFile,
                    inputFiles,
                    fallbackLogs:
                      '[CLSI Cache] Build up to date: workspace unchanged.',
                  });

                  dto.onLogChunk?.(
                    '[CLSI Cache] Build up to date: 0 source files modified. Returning cached output.',
                  );

                  return {
                    success: true,
                    status: 'success',
                    pdf: harvested.pdfBase64,
                    synctex: harvested.synctexBase64 || undefined,
                    logs: harvested.logs,
                    diagnostics:
                      harvested.diagnostics.length > 0
                        ? harvested.diagnostics
                        : undefined,
                    outputFiles: harvested.discoveredFiles,
                    durationMs: Date.now() - startTime,
                  };
                }
              }
            } catch {
              // Cache miss or missing file: proceed to standard compile
            }
          }

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
              error: errorMsg,
              logs: errorMsg,
              diagnostics: [
                {
                  file: mainFile,
                  line: 1,
                  message: errorMsg,
                  severity: 'error',
                  context: 'System Environment',
                },
              ],
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
              compilerOverride: compilerFlag,
              signal: dto.signal,
              onLogChunk: dto.onLogChunk,
            },
            compilerFlag,
          );

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
            fallbackLogs,
            shellEscapeAdvisories,
          });

          if (engineResult.pdfGenerated && harvested.pdfBase64) {
            try {
              await fs.writeFile(
                buildStatePath,
                JSON.stringify({
                  success: true,
                  mainFile,
                  engine: resolvedEngine,
                  draft: dto.draft ?? false,
                  timestamp: Date.now(),
                }),
                'utf8',
              );
            } catch {}

            return {
              success: true,
              status: 'success',
              pdf: harvested.pdfBase64,
              synctex: harvested.synctexBase64 || undefined,
              logs: harvested.logs,
              diagnostics:
                harvested.diagnostics.length > 0
                  ? harvested.diagnostics
                  : undefined,
              outputFiles: harvested.discoveredFiles,
              durationMs,
            };
          }

          try {
            await fs.unlink(buildStatePath);
          } catch {}

          return {
            success: false,
            status: 'failure',
            error:
              harvested.diagnostics.find((d) => d.severity === 'error')
                ?.message || 'LaTeX compilation failed to produce a PDF',
            pdf: harvested.pdfBase64 || undefined,
            synctex: harvested.synctexBase64 || undefined,
            logs: harvested.logs,
            diagnostics:
              harvested.diagnostics.length > 0
                ? harvested.diagnostics
                : undefined,
            outputFiles: harvested.discoveredFiles,
            durationMs,
            timedOut: engineResult.timedOut,
          };
        },
        { signal: dto.signal },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(
        `CompilePipeline execution error for project ${projectId}: ${message}`,
        stack,
      );
      return {
        success: false,
        status: 'failure',
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
    fallbackLogs?: string;
    shellEscapeAdvisories?: string[];
  }): Promise<{
    pdfBase64: string;
    synctexBase64: string;
    logs: string;
    diagnostics: CompilerDiagnostic[];
    discoveredFiles: DiscoveredOutputFile[];
  }> {
    const {
      scratchDir,
      mainFile,
      inputFiles,
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

    let logs = fallbackLogs;
    const logBuffer = await readSafeFile('output.log');
    if (logBuffer && logBuffer.length > 0) {
      logs = logBuffer.toString('utf8');
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

    const diagnostics = this.logParser.parse(logs, mainFile);

    if (shellEscapeAdvisories.length > 0) {
      for (const adv of shellEscapeAdvisories) {
        diagnostics.push({
          file: mainFile,
          line: null,
          message: `Document references '${adv}' which historically required shell-escape. Shell-escape is strictly disabled in the Flux isolated compile sandbox for security. If compiling fails, consider native LaTeX alternatives (e.g. listings package instead of minted).`,
          severity: 'info',
          code: 'SHELL_ESCAPE_ADVISORY',
        });
      }
    }

    return {
      pdfBase64,
      synctexBase64,
      logs,
      diagnostics,
      discoveredFiles,
    };
  }
}
