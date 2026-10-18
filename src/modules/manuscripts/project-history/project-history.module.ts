/**
 * project-history/project-history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { DocumentUpdaterModule } from '@/modules/manuscripts/document-updater/document-updater.module';

import { ProjectHistoryController } from './project-history.controller';
import { ProjectHistoryService } from './project-history.service';
import {
  ProjectHistoryRepository,
  MyersDiffEngineAdapter,
  ManuscriptCollectorAdapter,
  ManuscriptRestorerAdapter,
} from './project-history.repository';
import {
  IHistoryRepositoryPort,
  IDiffEnginePort,
  IProjectCollectorPort,
  IProjectRestorerPort,
} from './domain';

@Module({
  imports: [
    PrismaModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
    DocumentUpdaterModule,
  ],
  controllers: [ProjectHistoryController],
  providers: [
    ProjectHistoryService,
    ProjectHistoryRepository,

    // Driven Adapters
    MyersDiffEngineAdapter,
    ManuscriptCollectorAdapter,
    ManuscriptRestorerAdapter,

    // Ports SPI bindings
    {
      provide: IHistoryRepositoryPort,
      useExisting: ProjectHistoryRepository,
    },
    {
      provide: IDiffEnginePort,
      useExisting: MyersDiffEngineAdapter,
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
