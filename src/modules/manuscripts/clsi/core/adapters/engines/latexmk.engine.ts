/**
 * modules/manuscripts/clsi/core/adapters/engines/latexmk.engine.ts
 * TeX Live engine runner orchestrating latexmk with Overleaf-parity convergence flags.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ILatexEngine,
  EngineRunOptions,
  EngineRunResult,
} from '../../ports/engine.port';
import { ISandboxRunner } from '../../ports/runner.port';

export class LatexmkEngine implements ILatexEngine {
  readonly name = 'latexmk';

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly binaryPath: string = 'latexmk',
    private readonly defaultCompiler: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex'
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
    compilerOverride?: 'pdflatex' | 'xelatex' | 'lualatex'
  ): Promise<EngineRunResult> {
    const startTime = Date.now();
    const compiler = compilerOverride || this.defaultCompiler;

    let compilerFlag = '-pdf';
    if (compiler === 'xelatex') {
      compilerFlag = '-pdfxe';
    } else if (compiler === 'lualatex') {
      compilerFlag = '-pdflua';
    }

    // OVERLEAF CLSI CONVERGENCE FLAGS
    const args: string[] = [
      compilerFlag,
      '-cd',
      '-jobname=output',
      '-synctex=1',
      options.stopOnFirstError ? '-halt-on-error' : '-interaction=batchmode',
      ...(options.stopOnFirstError ? [] : ['-f']),
      ...(options.syntaxOnly ? ['-draftmode'] : []),
      ...(options.shellEscape ? ['-shell-escape'] : []),
      options.mainFile,
    ];

    const execResult = await this.runner.run(this.binaryPath, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 30000,
      signal: options.signal,
    });

    const durationMs = Date.now() - startTime;

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
