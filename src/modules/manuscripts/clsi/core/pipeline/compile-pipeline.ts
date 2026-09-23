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
import {
  IWorkspaceManager,
  WorkspaceFile,
} from '../ports/workspace.port';
import { ILatexEngine } from '../ports/engine.port';
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
  stopOnFirstError?: boolean;
  timeoutMs?: number;
  source?: string;
  files?: Record<string, string>;
  resources?: Array<{ path: string; content?: string; hash?: string }>;
}

export type CompilePipelineResult =
  | {
      success: true;
      pdf: string;
      synctex?: string;
      logs: string;
      diagnostics?: CompilerDiagnostic[];
      outputFiles?: DiscoveredOutputFile[];
      durationMs: number;
    }
  | {
      success: false;
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
    private readonly outputFileFinder: IOutputFileFinder = new OverleafOutputFileFinder()
  ) {}

  public async execute(
    dto: CompilePipelineRequest
  ): Promise<CompilePipelineResult> {
    const startTime = Date.now();
    const projectId = dto.projectId || 'default';
    let mainFile = dto.mainFile;
    if (!mainFile && dto.files) {
      mainFile = TexEngineDetector.detectMainFile(dto.files) || 'main.tex';
    } else if (!mainFile) {
      mainFile = 'main.tex';
    }

    if (!mainFile.endsWith('.tex')) {
      mainFile = `${mainFile}.tex`;
    }

    let mainSource =
      dto.source || (dto.files ? dto.files[mainFile] : undefined) || '';

    // TeX Magic Comments & Package-based Engine Detection (Overleaf CLSI Parity)
    const engineDetect = TexEngineDetector.detect(mainSource, dto.engine);
    const resolvedEngine = engineDetect.engine;

    if (!dto.mainFile && engineDetect.mainFileHint) {
      mainFile = engineDetect.mainFileHint;
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
        if (filePath === mainFile) continue;
        workspaceFiles.push({
          path: filePath,
          content,
        });
      }
    }

    if (dto.resources) {
      for (const res of dto.resources) {
        if (res.content !== undefined) {
          workspaceFiles.push({
            path: res.path,
            content: res.content,
            hash: res.hash,
          });
        }
      }
    }

    if (workspaceFiles.length === 0) {
      workspaceFiles.push({
        path: mainFile,
        content:
          '\\documentclass{article}\n\\begin{document}\n\\end{document}',
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
          await this.workspace.syncFiles(projectId, workspaceFiles);

          // Step 2b: Overleaf Extraneous Files Purge & Stale Output Cleanup
          await this.workspace.purgeExtraneousFiles(projectId, inputFiles);

          // Step 2c: Dynamic BibTeX / Biber Auto-Detection & .latexmkrc Generation
          const bibBackend = await BibBackendDetector.detect(
            mainSource,
            scratchDir,
            engineDetect.bibProgramHint
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
            const isSecondaryAvailable = await (engineToUse === this.latexmkEngine
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
          const timeoutMs = dto.timeoutMs || 30000;
          const stopOnFirstError = dto.stopOnFirstError ?? false;

          let engineResult;
          if ('compile' in engineToUse && engineToUse === this.latexmkEngine) {
            engineResult = await (this.latexmkEngine as any).compile(
              {
                cwd: scratchDir,
                mainFile,
                timeoutMs,
                stopOnFirstError,
                draft: dto.draft ?? false,
                syntaxOnly: dto.syntaxOnly ?? false,
                shellEscape: requiresShellEscape,
              },
              compilerFlag
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
            });
          }

          const durationMs = Date.now() - startTime;

          // Step 5: Collect Output Artifacts & Discover dynamically generated files
          const discoveredFiles = await this.outputFileFinder.find(
            scratchDir,
            inputFiles
          );

          const pdfPath = path.join(scratchDir, 'output.pdf');
          const logPath = path.join(scratchDir, 'output.log');
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
            return {
              success: true,
              pdf: pdfBase64,
              synctex: synctexBase64 || undefined,
              logs,
              diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
              outputFiles: discoveredFiles,
              durationMs,
            };
          }

          return {
            success: false,
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
        }
      );
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Compilation execution failed',
        logs: err.stack || err.message || '',
        durationMs: Date.now() - startTime,
      };
    }
  }
}
