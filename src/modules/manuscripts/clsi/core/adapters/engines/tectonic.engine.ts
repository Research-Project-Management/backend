/**
 * modules/manuscripts/clsi/core/adapters/engines/tectonic.engine.ts
 * Tectonic Rust engine adapter - single binary fast compilation
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ILatexEngine,
  EngineRunOptions,
  EngineRunResult,
} from '../../ports/engine.port';
import { ISandboxRunner } from '../../ports/runner.port';

export class TectonicEngine implements ILatexEngine {
  readonly name = 'tectonic';

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly binaryPath: string = 'tectonic'
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
      '--outdir',
      options.cwd,
      '-o',
      'output.pdf',
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
