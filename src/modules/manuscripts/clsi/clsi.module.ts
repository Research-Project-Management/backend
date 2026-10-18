/**
 * modules/manuscripts/clsi/clsi.module.ts
 * NestJS Module bundling CLSI controllers, workspace repository, and real engine/sandbox seams.
 * Pure in-process domain modules (log parser, synctex parser, engine detector, word counter,
 * fileset planner) are invoked directly without DI ceremony.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import { CoreModule as AppCoreModule } from '@/core';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ClsiController } from './clsi.controller';
import { ClsiService } from './services/clsi.service';
import { RemoteClsiClientAdapter } from './services/remote-clsi.client';
import { ClsiWorkspacePlannerService } from './services/workspace-planner.service';
import {
  OverleafIncrementalWorkspace,
  DiskUsageCleaner,
} from './repositories/incremental-workspace.repository';
import {
  CompilePipeline,
  LocalProcessRunner,
  DockerSandboxRunner,
  LatexmkEngine,
  TectonicEngine,
  ClsiHealthCheck,
} from './services/compile-pipeline.service';
import { ISandboxRunner } from './domain/clsi-ports';

const CLSI_SANDBOX_RUNNER = Symbol('CLSI_SANDBOX_RUNNER');

function resolveScratchDir(configService: ConfigService): string {
  return (
    configService.get<string>('CLSI_SCRATCH_DIR') ||
    configService.get<string>('SCRATCH_DIR') ||
    path.join(os.tmpdir(), 'clsi-scratch')
  );
}

@Module({
  imports: [AppCoreModule, DocstoreModule, FilestoreModule],
  controllers: [ClsiController],
  providers: [
    RemoteClsiClientAdapter,
    ClsiWorkspacePlannerService,
    {
      provide: OverleafIncrementalWorkspace,
      useFactory: (configService: ConfigService) =>
        new OverleafIncrementalWorkspace(resolveScratchDir(configService)),
      inject: [ConfigService],
    },
    {
      provide: CLSI_SANDBOX_RUNNER,
      useFactory: (configService: ConfigService): ISandboxRunner => {
        const useDocker =
          configService.get<string>('USE_DOCKER_SANDBOX') === 'true';
        const dockerImage =
          configService.get<string>('DOCKER_IMAGE') || 'sharelatex/clsi:latest';
        return useDocker
          ? new DockerSandboxRunner(dockerImage)
          : new LocalProcessRunner();
      },
      inject: [ConfigService],
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
      provide: TectonicEngine,
      useFactory: (runner: ISandboxRunner, configService: ConfigService) => {
        const tectonicBin =
          configService.get<string>('TECTONIC_BIN') || 'tectonic';
        return new TectonicEngine(runner, tectonicBin);
      },
      inject: [CLSI_SANDBOX_RUNNER, ConfigService],
    },
    {
      provide: DiskUsageCleaner,
      useFactory: (configService: ConfigService) =>
        new DiskUsageCleaner(resolveScratchDir(configService)),
      inject: [ConfigService],
    },
    {
      provide: ClsiHealthCheck,
      useFactory: (runner: ISandboxRunner, configService: ConfigService) =>
        new ClsiHealthCheck(runner, resolveScratchDir(configService)),
      inject: [CLSI_SANDBOX_RUNNER, ConfigService],
    },
    {
      provide: CompilePipeline,
      useFactory: (
        workspace: OverleafIncrementalWorkspace,
        latexmkEngine: LatexmkEngine,
        tectonicEngine: TectonicEngine,
      ) => new CompilePipeline(workspace, latexmkEngine, tectonicEngine),
      inject: [OverleafIncrementalWorkspace, LatexmkEngine, TectonicEngine],
    },
    ClsiService,
  ],
  exports: [ClsiService, RemoteClsiClientAdapter, ClsiWorkspacePlannerService],
})
export class ClsiModule {}
