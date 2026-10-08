/**
 * modules/manuscripts/clsi/core/pipeline/compile-pipeline.ts
 * Coordinates the 5-step LaTeX compilation pipeline:
 * 1. Request normalization & path sanitization
 * 2. Incremental workspace synchronization (ResourceWriter)
 * 3. Sandboxed Engine compilation (Latexmk / Tectonic)
 * 4. Output artifact collection & log parsing
 * 5. Diagnostic extraction & result preparation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { IWorkspaceManager, WorkspaceFile } from '../ports/workspace.port';
import { ILatexEngine, EngineRunResult } from '../ports/engine.port';
import {
  ILogParser,
  CompilerDiagnostic,
  DiscoveredOutputFile,
  IOutputFileFinder,
} from '../ports/artifacts.port';
import { ProjectLockManager } from '../adapters/workspace/project-lock.manager';
import { OverleafOutputFileFinder } from '../adapters/artifacts/output-file.finder';
import { TexEngineDetector } from '../adapters/engines/tex-engine.detector';
import { BibBackendDetector } from '../adapters/engines/bib-backend.detector';
import { DraftModeManager } from '../adapters/engines/draft-mode.manager';

export interface CompilePipelineRequest {
  projectId?: string;
  mainFile?: string;
  engine?: string;
  draft?: boolean;
  syntaxOnly?: boolean;
  force?: boolean;
  stopOnFirstError?: boolean;
  timeoutMs?: number;
  source?: string;
  files?: Record<string, string>;
  resources?: Array<{ path: string; content?: string; hash?: string }>;
  signal?: AbortSignal;
  onLogChunk?: (chunk: string) => void;
}

export interface OverleafOutputFileEntry {
  type: string;
  path: string;
  url: string;
  size?: number;
}

export interface OverleafClsiEnvelope {
  status: 'success' | 'failure';
  outputFiles: OverleafOutputFileEntry[];
}

function toOverleafOutputFiles(
  projectId: string,
  files: DiscoveredOutputFile[],
): OverleafOutputFileEntry[] {
  return files.map((f) => ({
    type: f.isMainPdf
      ? 'pdf'
      : f.isLog
        ? 'log'
        : f.isSynctex
          ? 'synctex'
          : 'aux',
    path: f.path,
    url: `/api/v1/manuscripts/projects/${projectId}/artifacts/${encodeURIComponent(f.path)}`,
    size: f.size,
  }));
}

export type CompilePipelineResult =
  | {
      success: true;
      status: 'success';
      compile: OverleafClsiEnvelope;
      pdf: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
    }
  | {
      success: false;
      status: 'failure';
      compile: OverleafClsiEnvelope;
      error: string;
      pdf?: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
    };

export class CompilePipeline {
  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly latexmkEngine: ILatexEngine,
    private readonly tectonicEngine: ILatexEngine,
    private readonly logParser: ILogParser,
    private readonly projectLockManager: ProjectLockManager = new ProjectLockManager(),
    private readonly outputFileFinder: IOutputFileFinder = new OverleafOutputFileFinder(),
  ) {}

  public async execute(
    dto: CompilePipelineRequest,
  ): Promise<CompilePipelineResult> {
    const startTime = Date.now();
    const cleanRelPath = (p: string) =>
      p
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');

    let mainFile = dto.mainFile ? cleanRelPath(dto.mainFile) : '';
    if (!mainFile && dto.files) {
      mainFile = TexEngineDetector.detectMainFile(dto.files) || 'main.tex';
    } else if (!mainFile) {
      mainFile = 'main.tex';
    }

    mainFile = cleanRelPath(mainFile);
    if (!mainFile.endsWith('.tex')) {
      mainFile = `${mainFile}.tex`;
    }

    let mainSource =
      dto.source ||
      (dto.files
        ? (dto.files[mainFile] ?? dto.files[`/${mainFile}`])
        : undefined) ||
      '';

    // TeX Magic Comments & Package-based Engine Detection (Overleaf CLSI Parity)
    const engineDetect = TexEngineDetector.detect(mainSource, dto.engine);
    const resolvedEngine = engineDetect.engine;

    if (!dto.mainFile && engineDetect.mainFileHint) {
      mainFile = cleanRelPath(engineDetect.mainFileHint);
      if (!mainFile.endsWith('.tex')) mainFile = `${mainFile}.tex`;
    }

    // Academic Draft Mode Transformation
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
          // Step 2: Incremental Workspace Sync (Overleaf ResourceWriter)
          const syncStats = await this.workspace.syncFiles(
            projectId,
            workspaceFiles,
          );

          const pdfPath = path.join(scratchDir, 'output.pdf');
          const logPath = path.join(scratchDir, 'output.log');
          const buildStatePath = path.join(
            scratchDir,
            '.clsi-build-state.json',
          );

          // Step 2a: Short-Circuit Cache Hit: If 0 files changed and build state matches, return cached PDF in <5ms
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
                  const pdfBuffer = await fs.readFile(pdfPath);
                  const pdfBase64 = pdfBuffer.toString('base64');
                  let logs = '';
                  try {
                    logs = await fs.readFile(logPath, 'utf8');
                  } catch {}

                  let synctexBase64 = '';
                  const synctexGzPath = path.join(
                    scratchDir,
                    'output.synctex.gz',
                  );
                  const synctexPlainPath = path.join(
                    scratchDir,
                    'output.synctex',
                  );
                  try {
                    const synctexBuffer = await fs.readFile(synctexGzPath);
                    synctexBase64 = synctexBuffer.toString('base64');
                  } catch {
                    try {
                      const synctexBuffer = await fs.readFile(synctexPlainPath);
                      synctexBase64 = synctexBuffer.toString('base64');
                    } catch {}
                  }

                  const discoveredFiles = await this.outputFileFinder.find(
                    scratchDir,
                    inputFiles,
                  );
                  function toOverleafOutputFiles(
                    projectId: string,
                    files?: DiscoveredOutputFile[],
                  ): OverleafOutputFileEntry[] {
                    if (!files || files.length === 0) return [];
                    return files.map((f) => {
                      let type = 'file';
                      if (f.isMainPdf) type = 'pdf';
                      else if (f.isLog) type = 'log';
                      else if (f.isSynctex) type = 'synctex.gz';
                      else {
                        const ext = path.extname(f.path).replace(/^\./, '');
                        if (ext) type = ext;
                      }
                      return {
                        type,
                        path: f.path,
                        url: `/api/v1/manuscripts/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(f.path)}`,
                        size: f.size,
                      };
                    });
                  }

                  const diagnostics = this.logParser.parse(logs, mainFile);

                  dto.onLogChunk?.(
                    '[CLSI Cache] Build up to date: 0 source files modified. Returning cached output.',
                  );

                  const overleafFiles = toOverleafOutputFiles(
                    projectId,
                    discoveredFiles,
                  );
                  return {
                    success: true,
                    status: 'success',
                    compile: {
                      status: 'success',
                      outputFiles: overleafFiles,
                    },
                    pdf: pdfBase64,
                    synctex: synctexBase64 || undefined,
                    logs:
                      logs ||
                      '[CLSI Cache] Build up to date: workspace unchanged.',
                    diagnostics:
                      diagnostics.length > 0 ? diagnostics : undefined,
                    outputFiles: discoveredFiles,
                    durationMs: Date.now() - startTime,
                  };
                }
              }
            } catch {
              // Cache miss or missing file: proceed to standard compile
            }
          }

          // Step 2b: Overleaf Extraneous Files Purge & Stale Output Cleanup
          await this.workspace.purgeExtraneousFiles(projectId, inputFiles);

          // Step 2c: Dynamic BibTeX / Biber Auto-Detection & .latexmkrc Generation
          const bibBackend = await BibBackendDetector.detect(
            mainSource,
            scratchDir,
            engineDetect.bibProgramHint,
          );
          const requiresShellEscape =
            DraftModeManager.requiresShellEscape(mainSource);

          await BibBackendDetector.writeLatexmkrc(scratchDir, {
            engine: resolvedEngine,
            bibBackend,
            shellEscape: requiresShellEscape,
          });

          // Step 3: Engine Selection
          let engineToUse: ILatexEngine = this.latexmkEngine;
          let compilerFlag: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex';

          if (resolvedEngine === 'tectonic') {
            engineToUse = this.tectonicEngine;
          } else if (resolvedEngine === 'xelatex') {
            compilerFlag = 'xelatex';
          } else if (resolvedEngine === 'lualatex') {
            compilerFlag = 'lualatex';
          }

          const isPrimaryAvailable = await engineToUse.isAvailable();
          if (!isPrimaryAvailable) {
            const isSecondaryAvailable = await (engineToUse ===
            this.latexmkEngine
              ? this.tectonicEngine.isAvailable()
              : this.latexmkEngine.isAvailable());
            if (isSecondaryAvailable) {
              engineToUse =
                engineToUse === this.latexmkEngine
                  ? this.tectonicEngine
                  : this.latexmkEngine;
            }
          }

          // Step 4: Run Compilation
          const timeoutMs = dto.timeoutMs || 240000;
          const stopOnFirstError = dto.stopOnFirstError ?? false;

          let engineResult: EngineRunResult;
          if ('compile' in engineToUse && engineToUse === this.latexmkEngine) {
            engineResult = await this.latexmkEngine.compile(
              {
                cwd: scratchDir,
                mainFile,
                timeoutMs,
                stopOnFirstError,
                draft: dto.draft ?? false,
                syntaxOnly: dto.syntaxOnly ?? false,
                shellEscape: requiresShellEscape,
                signal: dto.signal,
                onLogChunk: dto.onLogChunk,
              },
              compilerFlag,
            );
          } else {
            engineResult = await engineToUse.compile({
              cwd: scratchDir,
              mainFile,
              timeoutMs,
              stopOnFirstError,
              draft: dto.draft ?? false,
              syntaxOnly: dto.syntaxOnly ?? false,
              shellEscape: requiresShellEscape,
              signal: dto.signal,
              onLogChunk: dto.onLogChunk,
            });
          }

          const durationMs = Date.now() - startTime;

          // Step 5: Collect Output Artifacts & Discover dynamically generated files
          const discoveredFiles = await this.outputFileFinder.find(
            scratchDir,
            inputFiles,
          );

          const synctexGzPath = path.join(scratchDir, 'output.synctex.gz');
          const synctexPlainPath = path.join(scratchDir, 'output.synctex');

          let pdfBase64 = '';
          try {
            const pdfBuffer = await fs.readFile(pdfPath);
            pdfBase64 = pdfBuffer.toString('base64');
          } catch {
            // PDF not generated
          }

          let logs = engineResult.stdout || '';
          if (engineResult.stderr) {
            logs += `\n${engineResult.stderr}`;
          }
          try {
            const fileLog = await fs.readFile(logPath, 'utf8');
            if (fileLog) logs = fileLog;
          } catch {
            // Use stdout
          }

          let synctexBase64 = '';
          try {
            const synctexBuffer = await fs.readFile(synctexGzPath);
            synctexBase64 = synctexBuffer.toString('base64');
          } catch {
            try {
              const synctexBuffer = await fs.readFile(synctexPlainPath);
              synctexBase64 = synctexBuffer.toString('base64');
            } catch {
              // Synctex not generated
            }
          }

          const diagnostics = this.logParser.parse(logs, mainFile);

          if (engineResult.pdfGenerated && pdfBase64) {
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

            const overleafFiles = toOverleafOutputFiles(
              projectId,
              discoveredFiles,
            );
            return {
              success: true,
              status: 'success',
              compile: {
                status: 'success',
                outputFiles: overleafFiles,
              },
              pdf: pdfBase64,
              synctex: synctexBase64 || undefined,
              logs,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              outputFiles: discoveredFiles,
              durationMs,
            };
          }

          try {
            await fs.unlink(buildStatePath);
          } catch {}

          const overleafFiles = toOverleafOutputFiles(
            projectId,
            discoveredFiles,
          );
          return {
            success: false,
            status: 'failure',
            compile: {
              status: 'failure',
              outputFiles: overleafFiles,
            },
            error:
              diagnostics.find((d) => d.severity === 'error')?.message ||
              'LaTeX compilation failed to produce a PDF',
            pdf: pdfBase64 || undefined,
            synctex: synctexBase64 || undefined,
            logs,
            diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
            outputFiles: discoveredFiles,
            durationMs,
          };
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      return {
        success: false,
        status: 'failure',
        compile: {
          status: 'failure',
          outputFiles: [],
        },
        error: message || 'Compilation execution failed',
        logs: stack || message || '',
        durationMs: Date.now() - startTime,
      };
    }
  }
}
