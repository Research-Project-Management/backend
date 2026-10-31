/**
 * modules/manuscripts/clsi/clsi.module.ts
 * NestJS Module bundling CLSI controllers, workspace repository, and real engine/sandbox seams.
 * Pure in-process domain modules (log parser, synctex parser, engine detector, word counter,
 * fileset planner) are invoked directly without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MANUSCRIPT_CLSI_QUEUE } from '@/core/infrastructure/queue/bullmq.config';
import * as os from 'os';
import * as path from 'path';
import { CoreModule as AppCoreModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ClsiController } from './clsi.controller';
import { ClsiService } from './services/clsi.service';
import { RemoteClsiClientAdapter } from './services/remote-clsi.client';
import { ClsiWorkspacePlannerService } from './services/workspace-planner.service';
import { ClsiCompileProcessor } from './processors/clsi-compile.processor';
import {
  OverleafIncrementalWorkspace,
  DiskUsageCleaner,
} from './repositories/incremental-workspace.repository';
import {
  CompilePipeline,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './services/compile-pipeline.service';
import { ISandboxRunner } from './domain/clsi-ports';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
  ClsiSandboxConfig,
} from './services/sandbox/sandbox-config';
import { CompileFairQueue } from './services/compile-fair-queue.service';

export const CLSI_SANDBOX_CONFIG = Symbol('CLSI_SANDBOX_CONFIG');
export const CLSI_SANDBOX_RUNNER = Symbol('CLSI_SANDBOX_RUNNER');

const inProcessClsiWorkers =
  process.env.ENABLE_IN_PROCESS_WORKERS === 'true'
    ? [ClsiCompileProcessor]
    : [];

@Module({
  imports: [
    AppCoreModule,
    DocstoreModule,
    FilestoreModule,
    BullModule.registerQueue({
      name: MANUSCRIPT_CLSI_QUEUE,
    }),
  ],
  controllers: [ClsiController],
  providers: [
    RemoteClsiClientAdapter,
    ClsiWorkspacePlannerService,
    {
      provide: CLSI_SANDBOX_CONFIG,
      useFactory: (configService: ConfigService): ClsiSandboxConfig => {
        return parseSandboxConfig({
          env: {
            CLSI_SANDBOX_MODE: configService.get<string>('CLSI_SANDBOX_MODE'),
            CLSI_SANDBOX_IMAGE:
              configService.get<string>('CLSI_SANDBOX_IMAGE') ||
              configService.get<string>('CLSI_DOCKER_IMAGE'),
            CLSI_URL: configService.get<string>('CLSI_URL'),
            CLSI_REMOTE_URL: configService.get<string>('CLSI_REMOTE_URL'),
            CLSI_SANDBOX_USER: configService.get<string>('CLSI_SANDBOX_USER'),
            CLSI_SANDBOX_MEMORY_MB: configService.get<string>(
              'CLSI_SANDBOX_MEMORY_MB',
            ),
            CLSI_SANDBOX_CPUS: configService.get<string>('CLSI_SANDBOX_CPUS'),
            CLSI_SANDBOX_PIDS: configService.get<string>('CLSI_SANDBOX_PIDS'),
            CLSI_SANDBOX_FSIZE_MB: configService.get<string>(
              'CLSI_SANDBOX_FSIZE_MB',
            ),
            CLSI_SANDBOX_NOFILE: configService.get<string>(
              'CLSI_SANDBOX_NOFILE',
            ),
            CLSI_SANDBOX_TMPFS_MB: configService.get<string>(
              'CLSI_SANDBOX_TMPFS_MB',
            ),
            CLSI_SANDBOX_TIMEOUT_MS: configService.get<string>(
              'CLSI_SANDBOX_TIMEOUT_MS',
            ),
            CLSI_SANDBOX_RUNTIME: configService.get<string>(
              'CLSI_SANDBOX_RUNTIME',
            ),
            CLSI_SCRATCH_DIR:
              configService.get<string>('CLSI_SCRATCH_DIR') ||
              configService.get<string>('SCRATCH_DIR'),
            NODE_ENV: configService.get<string>('NODE_ENV'),
          },
          isProduction: configService.get<string>('NODE_ENV') === 'production',
        });
      },
      inject: [ConfigService],
    },
    {
      provide: OverleafIncrementalWorkspace,
      useFactory: (sandboxConfig: ClsiSandboxConfig) =>
        new OverleafIncrementalWorkspace(sandboxConfig.scratchDir),
      inject: [CLSI_SANDBOX_CONFIG],
    },
    {
      provide: CLSI_SANDBOX_RUNNER,
      useFactory: (sandboxConfig: ClsiSandboxConfig): ISandboxRunner => {
        return sandboxConfig.mode === 'container'
          ? new DockerSandboxRunner(
              sandboxConfig.image,
              `${sandboxConfig.memoryMb}m`,
              `${sandboxConfig.cpus}`,
              undefined,
              buildSandboxProfileFromConfig(sandboxConfig),
            )
          : new LocalProcessRunner();
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
      provide: DiskUsageCleaner,
      useFactory: (sandboxConfig: ClsiSandboxConfig) =>
        new DiskUsageCleaner(sandboxConfig.scratchDir),
      inject: [CLSI_SANDBOX_CONFIG],
    },
    {
      provide: ClsiHealthCheck,
      useFactory: (runner: ISandboxRunner, sandboxConfig: ClsiSandboxConfig) =>
        new ClsiHealthCheck(runner, sandboxConfig.scratchDir),
      inject: [CLSI_SANDBOX_RUNNER, CLSI_SANDBOX_CONFIG],
    },
    {
      provide: CompilePipeline,
      useFactory: (
        workspace: OverleafIncrementalWorkspace,
        latexmkEngine: LatexmkEngine,
      ) => new CompilePipeline(workspace, latexmkEngine),
      inject: [OverleafIncrementalWorkspace, LatexmkEngine],
    },
    CompileFairQueue,
    ClsiService,
    ...inProcessClsiWorkers,
  ],
  exports: [
    ClsiService,
    RemoteClsiClientAdapter,
    ClsiWorkspacePlannerService,
    BullModule,
  ],
})
export class ClsiModule {}
