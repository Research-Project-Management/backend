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
import { ProjectHistoryRepository } from './project-history.repository';

// Ports
import { IHistoryRepositoryPort } from './core/ports/history-repository.port';
import { IDiffEnginePort } from './core/ports/diff-engine.port';
import { IProjectCollectorPort } from './core/ports/project-collector.port';
import { IProjectRestorerPort } from './core/ports/project-restorer.port';

// Adapters
import { MyersDiffEngineAdapter } from './core/adapters/engine/myers-diff-engine.adapter';
import { ManuscriptCollectorAdapter } from './core/adapters/external/manuscript-collector.adapter';
import { ManuscriptRestorerAdapter } from './core/adapters/external/manuscript-restorer.adapter';

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
