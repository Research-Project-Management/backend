/**
 * project-history/project-history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Adaptive Modular Monolith).
 */

import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';

import { ProjectHistoryController } from './project-history.controller';
import { ProjectHistoryService } from './project-history.service';
import { ProjectHistoryRepository } from './project-history.repository';
import {
  ManuscriptCollectorAdapter,
  ManuscriptRestorerAdapter,
} from './adapters/project-history.adapters';
import {
  IHistoryRepositoryPort,
  IDiffEnginePort,
  IProjectCollectorPort,
  IProjectRestorerPort,
  MyersDiffEngine,
} from './domain';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => StructureModule),
    forwardRef(() => DocstoreModule),
    FilestoreModule,
  ],
  controllers: [ProjectHistoryController],
  providers: [
    ProjectHistoryService,
    ProjectHistoryRepository,

    // Driven Adapters
    {
      provide: MyersDiffEngine,
      useFactory: () => new MyersDiffEngine(),
    },
    ManuscriptCollectorAdapter,
    ManuscriptRestorerAdapter,

    // Ports SPI bindings
    {
      provide: IHistoryRepositoryPort,
      useExisting: ProjectHistoryRepository,
    },
    {
      provide: IDiffEnginePort,
      useExisting: MyersDiffEngine,
    },
    {
      provide: IProjectCollectorPort,
      useExisting: ManuscriptCollectorAdapter,
    },
    {
      provide: IProjectRestorerPort,
      useExisting: ManuscriptRestorerAdapter,
    },
  ],
  exports: [
    ProjectHistoryService,
    ProjectHistoryRepository,
    IHistoryRepositoryPort,
    IDiffEnginePort,
    IProjectCollectorPort,
    IProjectRestorerPort,
  ],
})
export class ProjectHistoryModule {}
