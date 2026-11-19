/**
 * modules/pages/clsi/services/latexmk.engine.ts
 * Sandbox-enforced LaTeX compilation engine implementations (`BaseLatexEngine`, `LatexmkEngine`).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import {
  EngineRunOptions,
  EngineRunResult,
  ILatexEngine,
  ISandboxRunner,
} from '../domain/clsi.ports';
import { SandboxPolicyViolationException } from '../domain/sandbox.errors';

export function hasControlChar(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

export function assertSafeMainFile(mainFile: string): string {
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

/**
 * Template Method base class for LaTeX compilation engines (`ILatexEngine`).
 * Centralizes shell-escape sandbox enforcement, mainFile path sanitization,
 * binary availability probing, and filesystem existence helpers so concrete
 * engine (`LatexmkEngine`) satisfies Liskov Substitution.
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
      'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex',
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
      safeMainFile,
    ];

    const isLinuxContainer = this.runner.name === 'docker-sandbox';
    const cwdPath = path.resolve(options.cwd);
    const texInputs = isLinuxContainer
      ? `.:/compile//:${options.env?.TEXINPUTS || ''}`
      : process.platform === 'win32'
        ? `.;${cwdPath}\\//;${options.env?.TEXINPUTS || ''}`
        : `.:${cwdPath}//:${options.env?.TEXINPUTS || ''}`;
    const bibInputs = isLinuxContainer
      ? `.:/compile//:${options.env?.BIBINPUTS || ''}`
      : process.platform === 'win32'
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
      openinAny: compiler === 'lualatex' ? 'r' : 'p',
    });

    const durationMs = Date.now() - startTime;

    const mainRelDir = path.posix.dirname(safeMainFile);
    if (mainRelDir && mainRelDir !== '.') {
      const mainDir = path.join(options.cwd, mainRelDir);
      const artifactsToPromote = [
        'output.pdf',
        'output.log',
        'output.blg',
        'output.synctex.gz',
        'output.synctex',
        'output.bbl',
        'output.fls',
        'output.aux',
        'output.out',
        'output.toc',
      ];
      try {
        const mainEntries = await fs.readdir(mainDir);
        for (const entryName of mainEntries) {
          if (
            entryName.toLowerCase().endsWith('.blg') &&
            !artifactsToPromote.includes(entryName)
          ) {
            artifactsToPromote.push(entryName);
          }
        }
      } catch {
        // mainDir may not exist
      }
      await Promise.all(
        artifactsToPromote.map(async (artifactName) => {
          const rootTarget = path.join(options.cwd, artifactName);
          const nestedSource = path.join(mainDir, artifactName);
          if (
            !(await this.fileExists(rootTarget)) &&
            (await this.fileExists(nestedSource))
          ) {
            await fs.copyFile(nestedSource, rootTarget).catch(() => {});
          }
        }),
      );
    }

    const pdfPath = path.join(options.cwd, 'output.pdf');
    const mainBase = path.parse(safeMainFile).name;
    const altPdfPath = path.join(options.cwd, `${mainBase}.pdf`);
    const synctexGzPath = path.join(options.cwd, 'output.synctex.gz');
    const synctexPlainPath = path.join(options.cwd, 'output.synctex');

    const [initialPdfGenerated, altPdfGenerated] = await Promise.all([
      this.fileExists(pdfPath),
      this.fileExists(altPdfPath),
    ]);
    const [synctexGzExists, synctexPlainExists] = await Promise.all([
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

    return {
      exitCode: execResult.exitCode,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      durationMs,
      pdfGenerated,
      synctexGenerated: synctexGzExists || synctexPlainExists,
      timedOut: execResult.timedOut,
    };
  }
}
