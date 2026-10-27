/**
 * modules/manuscripts/clsi/services/compile-pipeline.service.ts
 * Coordinates the 5-step LaTeX compilation pipeline across the real engine seam
 * (LatexmkEngine vs TectonicEngine), sandbox runners (LocalProcessRunner vs DockerSandboxRunner),
 * health check probes, and workspace repository, using pure in-process domain logic.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BadRequestException, Logger } from '@nestjs/common';
import {
  IWorkspaceManager,
  WorkspaceFile,
  ILatexEngine,
  EngineRunOptions,
  EngineRunResult,
  ILogParser,
  CompilerDiagnostic,
  DiscoveredOutputFile,
  IOutputFileFinder,
  ISandboxRunner,
  ProcessExecutionOptions,
  ProcessExecutionResult,
} from '../domain/clsi-ports';
import {
  ProjectLockManager,
  OverleafOutputFileFinder,
} from '../repositories/incremental-workspace.repository';
import { TexEngineDetector } from '../domain/tex-engine.detector';
import { CompileLogAnalyzer } from '@/modules/manuscripts/diagnostics/domain';
import { BibBackendDetector } from '../domain/bib-backend.detector';
import { DraftModeManager } from '../domain/draft-mode.manager';
import { SandboxPolicyViolationException } from '../domain/sandbox-errors';

function hasControlChar(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

function assertSafeMainFile(mainFile: string): string {
  const clean = (mainFile || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
  if (
    !clean ||
    clean.startsWith('-') ||
    clean.includes('..') ||
    hasControlChar(clean)
  ) {
    throw new BadRequestException(
      `Invalid or unsafe mainFile path: "${mainFile}"`,
    );
  }
  return clean;
}

// ─────────────────────────────────────────────────────────────────
// Process Watchdog & Sandbox Runners (re-exported from ./sandbox/*)
// ─────────────────────────────────────────────────────────────────

export { killProcessGroup, Watchdog } from './sandbox/process-watchdog';
export { LocalProcessRunner } from './sandbox/local-process.runner';
export { DockerSandboxRunner } from './sandbox/docker-sandbox.runner';

// ─────────────────────────────────────────────────────────────────
// LaTeX Engines (Template Method: BaseLatexEngine -> LatexmkEngine & TectonicEngine)
// ─────────────────────────────────────────────────────────────────

/**
 * Template Method base class for LaTeX compilation engines (`ILatexEngine`).
 * Centralizes shell-escape sandbox enforcement, mainFile path sanitization,
 * binary availability probing, and filesystem existence helpers so concrete
 * engines (`LatexmkEngine`, `TectonicEngine`) satisfy Liskov Substitution.
 */
export abstract class BaseLatexEngine implements ILatexEngine {
  abstract readonly name: string;
  protected abstract readonly versionArgs: string[];

  constructor(
    protected readonly runner: ISandboxRunner,
    protected readonly binaryPath: string,
  ) {}

  public async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner.run(this.binaryPath, this.versionArgs, {
        cwd: process.cwd(),
        timeoutMs: 5000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  public async compile(
    options: EngineRunOptions,
    compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex',
  ): Promise<EngineRunResult> {
    if (options.shellEscape) {
      throw new SandboxPolicyViolationException(
        'Shell escape is strictly disabled in compilation sandbox.',
      );
    }

    const safeMainFile = assertSafeMainFile(options.mainFile);
    const normalizedOptions: EngineRunOptions = {
      ...options,
      compilerOverride: compilerOverride ?? options.compilerOverride,
    };

    return this.executeEngineCompile(normalizedOptions, safeMainFile);
  }

  protected abstract executeEngineCompile(
    options: EngineRunOptions,
    safeMainFile: string,
  ): Promise<EngineRunResult>;

  protected async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class LatexmkEngine extends BaseLatexEngine {
  readonly name = 'latexmk';
  protected readonly versionArgs = ['-v'];

  constructor(
    runner: ISandboxRunner,
    binaryPath: string = 'latexmk',
    private readonly defaultCompiler:
      | 'pdflatex'
      | 'xelatex'
      | 'lualatex' = 'pdflatex',
  ) {
    super(runner, binaryPath);
  }

  protected async executeEngineCompile(
    options: EngineRunOptions,
    safeMainFile: string,
  ): Promise<EngineRunResult> {
    const startTime = Date.now();
    const compiler = options.compilerOverride || this.defaultCompiler;

    let compilerFlag = '-pdf';
    if (compiler === 'xelatex') {
      compilerFlag = '-pdfxe';
    } else if (compiler === 'lualatex') {
      compilerFlag = '-pdflua';
    }

    const args: string[] = [
      compilerFlag,
      '-cd',
      '-jobname=output',
      '-synctex=1',
      '-file-line-error',
      '-no-shell-escape',
      options.stopOnFirstError ? '-halt-on-error' : '-interaction=batchmode',
      ...(options.stopOnFirstError ? [] : ['-f']),
      ...(options.syntaxOnly ? ['-draftmode'] : []),
      '--',
      safeMainFile,
    ];

    const cwdPath = path.resolve(options.cwd);
    const texInputs =
      process.platform === 'win32'
        ? `.;${cwdPath}\\//;${options.env?.TEXINPUTS || ''}`
        : `.:${cwdPath}//:${options.env?.TEXINPUTS || ''}`;
    const bibInputs =
      process.platform === 'win32'
        ? `.;${cwdPath}\\//;${options.env?.BIBINPUTS || ''}`
        : `.:${cwdPath}//:${options.env?.BIBINPUTS || ''}`;

    const envWithInputs = {
      ...(options.env || {}),
      TEXINPUTS: texInputs,
      BIBINPUTS: bibInputs,
      BSTINPUTS: bibInputs,
    };

    const execResult = await this.runner.run(this.binaryPath, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 240000,
      signal: options.signal,
      onLogChunk: options.onLogChunk,
      env: envWithInputs,
    });

    const durationMs = Date.now() - startTime;

    const pdfPath = path.join(options.cwd, 'output.pdf');
    const mainBase = path.parse(safeMainFile).name;
    const altPdfPath = path.join(options.cwd, `${mainBase}.pdf`);
    const synctexGzPath = path.join(options.cwd, 'output.synctex.gz');
    const synctexPlainPath = path.join(options.cwd, 'output.synctex');

    const [initialPdfGenerated, altPdfGenerated] = await Promise.all([
      this.fileExists(pdfPath),
      this.fileExists(altPdfPath),
    ]);
    let [synctexGzExists, synctexPlainExists] = await Promise.all([
      this.fileExists(synctexGzPath),
      this.fileExists(synctexPlainPath),
    ]);
    let pdfGenerated = initialPdfGenerated;

    if (!pdfGenerated && altPdfGenerated) {
      try {
        await fs.copyFile(altPdfPath, pdfPath);
        pdfGenerated = true;
      } catch {}
    }

    if (
      !pdfGenerated &&
      !execResult.timedOut &&
      execResult.exitCode !== 137 &&
      !options.signal?.aborted
    ) {
      const forceResult = await this.runner.run(
        this.binaryPath,
        ['-g', ...args],
        {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs ?? 240000,
          signal: options.signal,
          onLogChunk: options.onLogChunk,
          env: envWithInputs,
        },
      );
      execResult.stdout =
        (execResult.stdout || '') + '\n' + (forceResult.stdout || '');
      execResult.stderr =
        (execResult.stderr || '') + '\n' + (forceResult.stderr || '');
      pdfGenerated = await this.fileExists(pdfPath);
      if (!pdfGenerated && (await this.fileExists(altPdfPath))) {
        await fs.copyFile(altPdfPath, pdfPath).catch(() => {});
        pdfGenerated = true;
      }
      [synctexGzExists, synctexPlainExists] = await Promise.all([
        this.fileExists(synctexGzPath),
        this.fileExists(synctexPlainPath),
      ]);
    }

    return {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      durationMs,
      pdfGenerated,
      synctexGenerated: synctexGzExists || synctexPlainExists,
    };
  }
}

export class TectonicEngine extends BaseLatexEngine {
  readonly name = 'tectonic';
  protected readonly versionArgs = ['--version'];

  constructor(runner: ISandboxRunner, binaryPath: string = 'tectonic') {
    super(runner, binaryPath);
  }

  protected async executeEngineCompile(
    options: EngineRunOptions,
    safeMainFile: string,
  ): Promise<EngineRunResult> {
    const startTime = Date.now();

    const args: string[] = [
      '-X',
      'compile',
      '--synctex',
      '--outdir',
      options.cwd,
      '--',
      safeMainFile,
    ];

    const execResult = await this.runner.run(this.binaryPath, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 240000,
      signal: options.signal,
      onLogChunk: options.onLogChunk,
    });

    const durationMs = Date.now() - startTime;

    const baseName = safeMainFile.replace(/\.[^/.]+$/, '');
    const generatedPdf = path.join(options.cwd, `${baseName}.pdf`);
    const targetPdf = path.join(options.cwd, 'output.pdf');
    try {
      if ((await this.fileExists(generatedPdf)) && generatedPdf !== targetPdf) {
        await fs.copyFile(generatedPdf, targetPdf);
      }
    } catch {}

    const generatedSynctex = path.join(options.cwd, `${baseName}.synctex.gz`);
    const targetSynctex = path.join(options.cwd, 'output.synctex.gz');
    try {
      if (
        (await this.fileExists(generatedSynctex)) &&
        generatedSynctex !== targetSynctex
      ) {
        await fs.copyFile(generatedSynctex, targetSynctex);
      }
    } catch {}

    const generatedBbl = path.join(options.cwd, `${baseName}.bbl`);
    const targetBbl = path.join(options.cwd, 'output.bbl');
    try {
      if ((await this.fileExists(generatedBbl)) && generatedBbl !== targetBbl) {
        await fs.copyFile(generatedBbl, targetBbl);
      }
    } catch {}

    const targetLog = path.join(options.cwd, 'output.log');
    const generatedLog = path.join(options.cwd, `${baseName}.log`);
    try {
      if (!(await this.fileExists(targetLog))) {
        if (await this.fileExists(generatedLog)) {
          await fs.copyFile(generatedLog, targetLog);
        } else {
          const logContent =
            `${execResult.stdout || ''}\n${execResult.stderr || ''}`.trim();
          await fs.writeFile(targetLog, logContent, 'utf8');
        }
      }
    } catch {}

    const pdfPath = path.join(options.cwd, 'output.pdf');
    const synctexGzPath = path.join(options.cwd, 'output.synctex.gz');
    const synctexPlainPath = path.join(options.cwd, 'output.synctex');

    const [pdfGenerated, synctexGzExists, synctexPlainExists] =
      await Promise.all([
        this.fileExists(pdfPath),
        this.fileExists(synctexGzPath),
        this.fileExists(synctexPlainPath),
      ]);

    return {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      durationMs,
      pdfGenerated,
      synctexGenerated: synctexGzExists || synctexPlainExists,
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// CLSI Health Check
// ─────────────────────────────────────────────────────────────────

export interface BinaryStatus {
  available: boolean;
  version?: string;
  error?: string;
}

export interface ClsiHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeSeconds: number;
  timestamp: string;
  scratchDirectory: {
    path: string;
    writable: boolean;
  };
  sandbox: {
    runner: string;
    mode: 'container' | 'local-unsafe';
  };
  compilers: {
    latexmk: BinaryStatus;
    pdflatex: BinaryStatus;
    xelatex: BinaryStatus;
    lualatex: BinaryStatus;
    biber: BinaryStatus;
    bibtex: BinaryStatus;
    tectonic: BinaryStatus;
  };
}

export class ClsiHealthCheck {
  private readonly startTime = Date.now();

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly scratchDir: string = '/tmp/clsi-scratch',
  ) {}

  public async checkHealth(): Promise<ClsiHealthReport> {
    const [
      latexmk,
      pdflatex,
      xelatex,
      lualatex,
      biber,
      bibtex,
      tectonic,
      scratchWritable,
    ] = await Promise.all([
      this.probeBinary('latexmk', ['-v']),
      this.probeBinary('pdflatex', ['-version']),
      this.probeBinary('xelatex', ['-version']),
      this.probeBinary('lualatex', ['-version']),
      this.probeBinary('biber', ['--version']),
      this.probeBinary('bibtex', ['--version']),
      this.probeBinary('tectonic', ['--version']),
      this.probeScratchDir(),
    ]);

    const hasAnyEngine =
      latexmk.available || pdflatex.available || tectonic.available;
    const hasStandardLatex = latexmk.available && pdflatex.available;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (!scratchWritable || !hasAnyEngine) {
      status = 'unhealthy';
    } else if (!hasStandardLatex) {
      status = 'degraded';
    }

    const sandboxMode =
      this.runner.name === 'docker-sandbox' ? 'container' : 'local-unsafe';

    return {
      status,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      scratchDirectory: {
        path: this.scratchDir,
        writable: scratchWritable,
      },
      sandbox: {
        runner: this.runner.name,
        mode: sandboxMode,
      },
      compilers: {
        latexmk,
        pdflatex,
        xelatex,
        lualatex,
        biber,
        bibtex,
        tectonic,
      },
    };
  }

  private async probeBinary(
    binary: string,
    versionArgs: string[],
  ): Promise<BinaryStatus> {
    try {
      const result = await this.runner.run(binary, versionArgs, {
        cwd: process.cwd(),
        timeoutMs: 3000,
      });

      if (result.exitCode === 0) {
        const firstLine = (result.stdout || result.stderr || '')
          .split('\n')[0]
          .trim();
        return { available: true, version: firstLine };
      }

      return { available: false, error: `Exited with code ${result.exitCode}` };
    } catch (err: unknown) {
      return { available: false, error: (err as Error)?.message };
    }
  }

  private async probeScratchDir(): Promise<boolean> {
    try {
      await fs.mkdir(this.scratchDir, { recursive: true });
      const testFile = path.join(this.scratchDir, `.probe-${Date.now()}`);
      await fs.writeFile(testFile, 'probe');
      await fs.unlink(testFile);
      return true;
    } catch {
      return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Compile Pipeline Orchestrator
// ─────────────────────────────────────────────────────────────────

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
  private readonly logger = new Logger(CompilePipeline.name);

  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly latexmkEngine: ILatexEngine,
    private readonly tectonicEngine: ILatexEngine,
    private readonly logParser: ILogParser = new CompileLogAnalyzer(),
    private readonly projectLockManager: ProjectLockManager = new ProjectLockManager(),
    private readonly outputFileFinder: IOutputFileFinder = new OverleafOutputFileFinder(),
  ) {}

  public async runWithProjectLock<T>(
    projectId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const resolvedId = projectId || 'default-project';
    const scratchDir = this.workspace.getScratchDir(resolvedId);
    return this.projectLockManager.runWithLock(resolvedId, scratchDir, action);
  }

  public async execute(
    dto: CompilePipelineRequest,
  ): Promise<CompilePipelineResult> {
    const startTime = Date.now();
    const projectId = dto.projectId || 'default-project';
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
          const logPath = path.join(scratchDir, 'output.log');
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
                    compile: {
                      status: 'success',
                      outputFiles: harvested.overleafFiles,
                    },
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

          const resolvedRunner = await this.resolveAvailableEngine(
            resolvedEngine,
          );
          if (!resolvedRunner) {
            const errorMsg =
              'No supported TeX engine (latexmk or tectonic) was found in PATH or sandbox runner. Please install TeX Live (latexmk) or Tectonic, or configure CLSI_URL / Docker runner.';
            return {
              success: false,
              status: 'failure',
              compile: {
                status: 'failure',
                outputFiles: [],
              },
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
              compile: {
                status: 'success',
                outputFiles: harvested.overleafFiles,
              },
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
            compile: {
              status: 'failure',
              outputFiles: harvested.overleafFiles,
            },
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
          };
        },
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
        compile: {
          status: 'failure',
          outputFiles: [],
        },
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
    preferred: 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic',
  ): Promise<{
    engineToUse: ILatexEngine;
    compilerFlag: 'pdflatex' | 'xelatex' | 'lualatex';
  } | null> {
    let engineToUse: ILatexEngine = this.latexmkEngine;
    let compilerFlag: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex';

    if (preferred === 'tectonic') {
      engineToUse = this.tectonicEngine;
    } else if (preferred === 'xelatex') {
      compilerFlag = 'xelatex';
    } else if (preferred === 'lualatex') {
      compilerFlag = 'lualatex';
    }

    if (await engineToUse.isAvailable()) {
      return { engineToUse, compilerFlag };
    }

    const secondaryEngine =
      engineToUse === this.latexmkEngine
        ? this.tectonicEngine
        : this.latexmkEngine;
    if (await secondaryEngine.isAvailable()) {
      return { engineToUse: secondaryEngine, compilerFlag };
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
    overleafFiles: OverleafOutputFileEntry[];
  }> {
    const {
      scratchDir,
      projectId,
      mainFile,
      inputFiles,
      fallbackLogs = '',
      shellEscapeAdvisories = [],
    } = params;

    const pdfPath = path.join(scratchDir, 'output.pdf');
    const logPath = path.join(scratchDir, 'output.log');
    const synctexGzPath = path.join(scratchDir, 'output.synctex.gz');
    const synctexPlainPath = path.join(scratchDir, 'output.synctex');

    const discoveredFiles = await this.outputFileFinder.find(
      scratchDir,
      inputFiles,
    );

    let pdfBase64 = '';
    try {
      const pdfBuffer = await fs.readFile(pdfPath);
      pdfBase64 = pdfBuffer.toString('base64');
    } catch {
      // PDF not generated
    }

    let logs = fallbackLogs;
    try {
      const fileLog = await fs.readFile(logPath, 'utf8');
      if (fileLog) logs = fileLog;
    } catch {
      // Use fallbackLogs
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

    const overleafFiles = toOverleafOutputFiles(projectId, discoveredFiles);

    return {
      pdfBase64,
      synctexBase64,
      logs,
      diagnostics,
      discoveredFiles,
      overleafFiles,
    };
  }
}
