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
import { CoreModule as AppCoreModule } from '@/core';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { AiModule } from '@/modules/ai';
import { ClsiController } from './clsi.controller';
import { ClsiService } from './services/clsi.service';
import { RemoteClsiClientAdapter } from './services/remote-clsi.client';
import { WorkspacePlannerService } from './services/workspace-planner.service';
import { ClsiCompileProcessor } from './processors/clsi-compile.processor';
import {
  WorkspaceRepository,
  DiskUsageCleaner,
} from './repositories/workspace.repository';
import {
  CompilePipeline,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  ClsiHealthCheck,
} from './services/compile-pipeline.service';
import { ISandboxRunner } from './domain/clsi.ports';
import {
  parseSandboxConfig,
  buildSandboxProfileFromConfig,
  extractSandboxEnvFromConfigService,
  ClsiSandboxConfig,
} from './services/sandbox/sandbox-config';
import { CompileQueueService } from './services/compile-queue.service';

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
    AiModule,
    BullModule.registerQueue({
      name: MANUSCRIPT_CLSI_QUEUE,
    }),
  ],
  controllers: [ClsiController],
  providers: [
    RemoteClsiClientAdapter,
    WorkspacePlannerService,
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
      provide: WorkspaceRepository,
      useFactory: (sandboxConfig: ClsiSandboxConfig) =>
        new WorkspaceRepository(sandboxConfig.scratchDir),
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
        workspace: WorkspaceRepository,
        latexmkEngine: LatexmkEngine,
      ) => new CompilePipeline(workspace, latexmkEngine),
      inject: [WorkspaceRepository, LatexmkEngine],
    },
    CompileQueueService,
    ClsiService,
    ...inProcessClsiWorkers,
  ],
  exports: [
    ClsiService,
    RemoteClsiClientAdapter,
    WorkspacePlannerService,
    BullModule,
  ],
})
export class ClsiModule {}
