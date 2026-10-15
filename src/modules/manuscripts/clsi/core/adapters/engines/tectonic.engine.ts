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
} from '@/modules/manuscripts/clsi/core/ports/engine.port';
import { ISandboxRunner } from '@/modules/manuscripts/clsi/core/ports/runner.port';

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

    // Normalize output artifact filenames to Overleaf CLSI standards (output.pdf, output.synctex.gz, output.log, output.bbl)
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
