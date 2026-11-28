/**
 * modules/pages/clsi/clsi.module.ts
 * NestJS Module bundling CLSI controllers, workspace repository, and real engine/sandbox seams.
 * Pure in-process domain modules (log parser, synctex parser, engine detector, word counter,
 * fileset planner) are invoked directly without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { FilestoreModule } from '@/modules/pages/filestore';
import { HistoryModule } from '@/modules/pages/history';
import { ClsiController } from './clsi.controller';
import { ClsiService } from './clsi.service';
import { RemoteClsiClientAdapter } from './adapters/remote-clsi.adapter';
import { CompileSourceService } from './services/compile-source.service';
import { ClsiRepository } from './clsi.repository';
import { DiskUsageCleaner } from './adapters/scratch-disk.adapter';
import { CompileService } from './services/compile.service';
import { LocalProcessRunner } from './sandbox/local.sandbox';
import { DockerSandboxRunner } from './sandbox/docker.sandbox';
import { LatexmkEngine } from './adapters/latexmk.adapter';
import { ClsiHealthCheck } from './adapters/health.adapter';
import { TexcountCliAdapter } from './adapters/texcount.adapter';
import { ISandboxRunner } from './domain/ports';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
  extractSandboxEnvFromConfigService,
  ClsiSandboxConfig,
} from './sandbox/sandbox.config';
import { CompileLockService } from './services/compile-lock.service';
import { SynctexService } from './services/synctex.service';
import { WordCountService } from './services/wordcount.service';
import { OutputService } from './services/output.service';
import { ClsiMetrics } from './adapters/metrics.adapter';
import { ClsiRuntimeAdapter } from './adapters/clsi-runtime.adapter';

const CLSI_SANDBOX_CONFIG = Symbol('CLSI_SANDBOX_CONFIG');
const CLSI_SANDBOX_RUNNER = Symbol('CLSI_SANDBOX_RUNNER');

@Module({
  imports: [AppCoreModule, DocstoreModule, FilestoreModule, HistoryModule],
  controllers: [ClsiController],
  providers: [
    RemoteClsiClientAdapter,
    CompileSourceService,
    {
      provide: CLSI_SANDBOX_CONFIG,
      useFactory: (configService: ConfigService): ClsiSandboxConfig => {
        return parseSandboxConfig({
          env: extractSandboxEnvFromConfigService(configService),
          isProduction: configService.get<string>('NODE_ENV') === 'production',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: ClsiRepository,
      useFactory: (sandboxConfig: ClsiSandboxConfig) =>
        new ClsiRepository(sandboxConfig.scratchDir),
      inject: [CLSI_SANDBOX_CONFIG],
    },
    {
      provide: CLSI_SANDBOX_RUNNER,
      useFactory: (sandboxConfig: ClsiSandboxConfig): ISandboxRunner => {
        if (sandboxConfig.mode === 'container') {
          return new DockerSandboxRunner(
            sandboxConfig.image,
            `${sandboxConfig.memoryMb}m`,
            `${sandboxConfig.cpus}`,
            undefined,
            buildSandboxProfileFromConfig(sandboxConfig),
          );
        }
        if (sandboxConfig.mode === 'remote') {
          return {
            name: 'disabled-remote-sandbox',
            run: async () => {
              throw new Error(
                'Local LaTeX execution is disabled when CLSI remote mode is active.',
              );
            },
          };
        }
        return new LocalProcessRunner();
      },
      inject: [CLSI_SANDBOX_CONFIG],
    },
    {
      provide: LatexmkEngine,
      useFactory: (runner: ISandboxRunner, configService: ConfigService) => {
        const latexmkBin =
          configService.get<string>('LATEXMK_BIN') || 'latexmk';
        return new LatexmkEngine(runner, latexmkBin, 'pdflatex');
      },
      inject: [CLSI_SANDBOX_RUNNER, ConfigService],
    },
    {
      provide: TexcountCliAdapter,
      useFactory: (runner: ISandboxRunner, configService: ConfigService) => {
        const texcountBin =
          configService.get<string>('TEXCOUNT_BIN') || 'texcount';
        return new TexcountCliAdapter(texcountBin, runner);
      },
      inject: [CLSI_SANDBOX_RUNNER, ConfigService],
    },
    {
      provide: DiskUsageCleaner,
      useFactory: (
        sandboxConfig: ClsiSandboxConfig,
        configService: ConfigService,
      ) => {
        const isTest = configService.get<string>('NODE_ENV') === 'test';
        const rawInterval = configService.get<string>(
          'CLSI_SCRATCH_GC_INTERVAL_MS',
        );
        const gcIntervalMs = isTest
          ? 0
          : rawInterval !== undefined
            ? Number(rawInterval)
            : DiskUsageCleaner.DEFAULT_GC_INTERVAL_MS;
        return new DiskUsageCleaner(sandboxConfig.scratchDir, gcIntervalMs);
      },
      inject: [CLSI_SANDBOX_CONFIG, ConfigService],
    },
    {
      provide: ClsiHealthCheck,
      useFactory: (runner: ISandboxRunner, sandboxConfig: ClsiSandboxConfig) =>
        new ClsiHealthCheck(runner, sandboxConfig.scratchDir),
      inject: [CLSI_SANDBOX_RUNNER, CLSI_SANDBOX_CONFIG],
    },
    {
      provide: CompileService,
      useFactory: (workspace: ClsiRepository, latexmkEngine: LatexmkEngine) =>
        new CompileService(workspace, latexmkEngine),
      inject: [ClsiRepository, LatexmkEngine],
    },
    ClsiMetrics,
    ClsiRuntimeAdapter,
    {
      provide: CompileLockService,
      useFactory: (configService: ConfigService) => {
        const rawMax = Number(
          configService.get<string>('CLSI_MAX_CONCURRENT_COMPILES'),
        );
        const isRemoteProxy = Boolean(
          (configService.get<string>('CLSI_URL') || '').trim(),
        );
        return new CompileLockService({
          ...(Number.isFinite(rawMax) && rawMax >= 1
            ? { maxConcurrentCompiles: Math.floor(rawMax) }
            : {}),
          isRemoteProxy,
        });
      },
      inject: [ConfigService],
    },
    SynctexService,
    WordCountService,
    OutputService,
    ClsiService,
  ],
  exports: [ClsiService],
})
export class ClsiModule {}
