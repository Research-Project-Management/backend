/**
 * modules/manuscripts/clsi/services/compile-pipeline.service.ts
 * Coordinates the 5-step LaTeX compilation pipeline across the real engine seam
 * (LatexmkEngine vs TectonicEngine), sandbox runners (LocalProcessRunner vs DockerSandboxRunner),
 * health check probes, and workspace repository, using pure in-process domain logic.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
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
import { OverleafLogParser } from '../domain/overleaf-log.parser';
import { BibBackendDetector } from '../domain/bib-backend.detector';
import { DraftModeManager } from '../domain/draft-mode.manager';

// ─────────────────────────────────────────────────────────────────
// Process Watchdog & Sandbox Runners
// ─────────────────────────────────────────────────────────────────

export function killProcessGroup(pid: number, force = false): void {
  if (process.platform === 'win32') {
    try {
      const args = ['/F', '/T', '/PID', pid.toString()];
      spawn('taskkill', args, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === 'ESRCH') return;
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}

export class Watchdog {
  private timeoutTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private aborted = false;
  private abortReason?: string;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeoutMs: number = 240000,
    private readonly gracePeriodMs: number = 2000,
  ) {}

  arm(signal?: AbortSignal): void {
    if (signal) {
      if (signal.aborted) {
        this.terminate('ABORTED_IMMEDIATELY');
        return;
      }
      signal.addEventListener('abort', () => this.terminate('SIGNAL_ABORTED'), {
        once: true,
      });
    }

    this.timeoutTimer = setTimeout(() => {
      this.terminate('TIMEOUT');
    }, this.timeoutMs);
  }

  disarm(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  isAborted(): boolean {
    return this.aborted;
  }

  getAbortReason(): string | undefined {
    return this.abortReason;
  }

  terminate(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;

    const pid = this.child.pid;
    if (!pid) return;

    killProcessGroup(pid, false);

    this.killTimer = setTimeout(() => {
      killProcessGroup(pid, true);
    }, this.gracePeriodMs);
  }
}

export class LocalProcessRunner implements ISandboxRunner {
  readonly name = 'local-process';

  private static readonly activeChildProcesses = new Set<ChildProcess>();
  private static shutdownHooksRegistered = false;

  private static registerShutdownHooks(): void {
    if (this.shutdownHooksRegistered) return;
    this.shutdownHooksRegistered = true;

    const cleanup = () => {
      for (const child of this.activeChildProcesses) {
        if (child.pid && !child.killed) {
          killProcessGroup(child.pid, true);
        }
      }
      this.activeChildProcesses.clear();
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
    process.once('exit', cleanup);
  }

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    LocalProcessRunner.registerShutdownHooks();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(command, args, {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
        },
        detached: process.platform !== 'win32',
        shell: false,
      });

      LocalProcessRunner.activeChildProcesses.add(child);

      const watchdog = new Watchdog(child, options.timeoutMs ?? 240000);
      watchdog.arm(options.signal);

      child.stdout?.on('data', (data) => {
        const str = data.toString();
        stdout += str;
        options.onLogChunk?.(str);
      });

      child.stderr?.on('data', (data) => {
        const str = data.toString();
        stderr += str;
        options.onLogChunk?.(str);
      });

      child.on('error', (err) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
        });
      });

      child.on('close', (code) => {
        LocalProcessRunner.activeChildProcesses.delete(child);
        watchdog.disarm();
        if (watchdog.isAborted()) {
          const timeoutAdvice =
            '\n\n[Compilation Timeout — Troubleshooting Suggestions]\n' +
            'Your compilation timed out. Common causes and solutions:\n' +
            '  1. Infinite loops or recursion in custom macros, TikZ code, or complex tables.\n' +
            '  2. Very large, uncompressed high-resolution images (switch to "Draft mode" in Settings).\n' +
            '  3. Unclosed environments, braces, or math delimiters.\n' +
            '  4. Corrupted auxiliary files (click "Clear cached files" in Settings).';
          resolve({
            exitCode: 137,
            stdout,
            stderr: stderr
              ? `${stderr}\nCompilation timed out or was canceled.${timeoutAdvice}`
              : `Compilation timed out or was canceled.${timeoutAdvice}`,
          });
          return;
        }

        resolve({
          exitCode: code ?? 0,
          stdout,
          stderr,
        });
      });
    });
  }
}

export class DockerSandboxRunner implements ISandboxRunner {
  readonly name = 'docker-sandbox';
  private readonly localRunner = new LocalProcessRunner();

  constructor(
    private readonly dockerImage: string = 'sharelatex/clsi:latest',
    private readonly memoryLimit: string = '1024m',
    private readonly cpuLimit: string = '1.0',
  ) {}

  public async run(
    command: string,
    args: string[],
    options: ProcessExecutionOptions,
  ): Promise<ProcessExecutionResult> {
    const envArgs: string[] = [];
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v !== undefined) {
          const containerVal =
            typeof v === 'string'
              ? v.split(options.cwd).join('/compile').replace(/\\/g, '/')
              : String(v);
          envArgs.push('-e', `${k}=${containerVal}`);
        }
      }
    }

    const dockerArgs = [
      'run',
      '--rm',
      '--net=none',
      `--memory=${this.memoryLimit}`,
      `--cpus=${this.cpuLimit}`,
      '--pids-limit=100',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '-v',
      `${options.cwd}:/compile:rw`,
      '-w',
      '/compile',
      ...envArgs,
      this.dockerImage,
      command,
      ...args,
    ];

    const result = await this.localRunner.run('docker', dockerArgs, options);

    if (
      result.exitCode !== 0 &&
      result.stderr.includes('docker: command not found')
    ) {
      throw new Error('Docker is not installed or available on this system');
    }

    return result;
  }
}

// ─────────────────────────────────────────────────────────────────
// LaTeX Engines (LatexmkEngine & TectonicEngine)
// ─────────────────────────────────────────────────────────────────

export class LatexmkEngine implements ILatexEngine {
  readonly name = 'latexmk';

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly binaryPath: string = 'latexmk',
    private readonly defaultCompiler:
      'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex',
  ) {}

  public async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner.run(this.binaryPath, ['-v'], {
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
    const startTime = Date.now();
    const compiler = compilerOverride || this.defaultCompiler;

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
      options.stopOnFirstError ? '-halt-on-error' : '-interaction=batchmode',
      ...(options.stopOnFirstError ? [] : ['-f']),
      ...(options.syntaxOnly ? ['-draftmode'] : []),
      ...(options.shellEscape ? ['-shell-escape'] : []),
      options.mainFile,
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
    const mainBase = path.parse(options.mainFile).name;
    const altPdfPath = path.join(options.cwd, `${mainBase}.pdf`);
    const synctexGzPath = path.join(options.cwd, 'output.synctex.gz');
    const synctexPlainPath = path.join(options.cwd, 'output.synctex');

    const [
      initialPdfGenerated,
      altPdfGenerated,
      synctexGzExists,
      synctexPlainExists,
    ] = await Promise.all([
      this.fileExists(pdfPath),
      this.fileExists(altPdfPath),
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

    if (!pdfGenerated) {
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

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class TectonicEngine implements ILatexEngine {
  readonly name = 'tectonic';

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly binaryPath: string = 'tectonic',
  ) {}

  public async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner.run(this.binaryPath, ['--version'], {
        cwd: process.cwd(),
        timeoutMs: 5000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  public async compile(options: EngineRunOptions): Promise<EngineRunResult> {
    const startTime = Date.now();

    const args: string[] = [
      '-X',
      'compile',
      '--synctex',
      ...(options.shellEscape ? ['-Z', 'shell-escape'] : []),
      '--outdir',
      options.cwd,
      options.mainFile,
    ];

    const execResult = await this.runner.run(this.binaryPath, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 240000,
      signal: options.signal,
      onLogChunk: options.onLogChunk,
    });

    const durationMs = Date.now() - startTime;

    const baseName = options.mainFile.replace(/\.[^/.]+$/, '');
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

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
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

    return {
      status,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      scratchDirectory: {
        path: this.scratchDir,
        writable: scratchWritable,
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
  constructor(
    private readonly workspace: IWorkspaceManager,
    private readonly latexmkEngine: ILatexEngine,
    private readonly tectonicEngine: ILatexEngine,
    private readonly logParser: ILogParser = new OverleafLogParser(),
    private readonly projectLockManager: ProjectLockManager = new ProjectLockManager(),
    private readonly outputFileFinder: IOutputFileFinder = new OverleafOutputFileFinder(),
  ) {}

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
    const requiresShellEscape = Boolean(engineDetect.requiresShellEscape);

    if (!dto.mainFile && engineDetect.mainFileHint) {
      mainFile = cleanRelPath(engineDetect.mainFileHint);
      if (!mainFile.endsWith('.tex')) mainFile = `${mainFile}.tex`;
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
              shellEscape: requiresShellEscape,
            },
            userLatexmkFile?.content
              ? Buffer.isBuffer(userLatexmkFile.content)
                ? userLatexmkFile.content.toString('utf8')
                : String(userLatexmkFile.content)
              : undefined,
          );

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
            } else {
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
          }

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

export { CompilePipeline as CompilePipelineService };
