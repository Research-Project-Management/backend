/**
 * modules/manuscripts/clsi/core/adapters/engines/health-check.ts
 * Probes host/container environment for TeX Live binaries, compiler versions,
 * and scratch directory access. Matches Overleaf CLSI HealthCheck.js.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ISandboxRunner } from '../../ports/runner.port';

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
    private readonly scratchDir: string = '/tmp/clsi-scratch'
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

    // System is healthy if at least one engine is available and scratch is writable
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
    versionArgs: string[]
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
    } catch (err: any) {
      return { available: false, error: err.message };
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
