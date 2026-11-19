/**
 * modules/pages/clsi/services/clsi-health.check.ts
 * CLSI binary availability and scratch directory health check probe.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ISandboxRunner } from '../domain/clsi.ports';

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
  };
  remote?: {
    url: string | null;
    reachable: boolean;
  };
}

export class ClsiHealthCheck {
  private readonly startTime = Date.now();
  private cachedReport: { report: ClsiHealthReport; expiresAt: number } | null =
    null;
  private inFlightCheck: Promise<ClsiHealthReport> | null = null;
  private static readonly CACHE_TTL_MS = 30000;

  constructor(
    private readonly runner: ISandboxRunner,
    private readonly scratchDir: string = '/tmp/clsi-scratch',
  ) {}

  public async checkHealth(): Promise<ClsiHealthReport> {
    if (this.cachedReport && Date.now() < this.cachedReport.expiresAt) {
      return {
        ...this.cachedReport.report,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      };
    }

    if (this.inFlightCheck) {
      return this.inFlightCheck;
    }

    this.inFlightCheck = this.performHealthCheck().finally(() => {
      this.inFlightCheck = null;
    });
    return this.inFlightCheck;
  }

  private async performHealthCheck(): Promise<ClsiHealthReport> {
    const [
      latexmk,
      pdflatex,
      xelatex,
      lualatex,
      biber,
      bibtex,
      scratchWritable,
    ] = await Promise.all([
      this.probeBinary('latexmk', ['-v']),
      this.probeBinary('pdflatex', ['-version']),
      this.probeBinary('xelatex', ['-version']),
      this.probeBinary('lualatex', ['-version']),
      this.probeBinary('biber', ['--version']),
      this.probeBinary('bibtex', ['--version']),
      this.probeScratchDir(),
    ]);

    const hasAnyEngine = latexmk.available || pdflatex.available;
    const hasStandardLatex = latexmk.available && pdflatex.available;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (!scratchWritable || !hasAnyEngine) {
      status = 'unhealthy';
    } else if (!hasStandardLatex) {
      status = 'degraded';
    }

    const sandboxMode =
      this.runner.name === 'docker-sandbox' ? 'container' : 'local-unsafe';

    const report: ClsiHealthReport = {
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
      },
    };

    this.cachedReport = {
      report,
      expiresAt: Date.now() + ClsiHealthCheck.CACHE_TTL_MS,
    };

    return report;
  }

  private async probeBinary(
    binary: string,
    versionArgs: string[],
  ): Promise<BinaryStatus> {
    try {
      const result = await this.runner.run(binary, versionArgs, {
        cwd: process.cwd(),
        timeoutMs: 8000,
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
