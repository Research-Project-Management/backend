/**
 * project-history/project-history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Hexagonal Architecture).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { StructureModule } from '../structure/structure.module';
import { DocstoreModule } from '../docstore/docstore.module';
import { FilestoreModule } from '../filestore/filestore.module';
import { DocumentUpdaterModule } from '../document-updater/document-updater.module';

import { ProjectHistoryController } from './project-history.controller';
import { ProjectHistoryService } from './project-history.service';

// Use Cases
import { CreateSnapshotUseCase } from './core/use-cases/create-snapshot.use-case';
import { GetVersionListUseCase } from './core/use-cases/get-version-list.use-case';
import { GetSnapshotByVersionUseCase } from './core/use-cases/get-snapshot-by-version.use-case';
import { CompareVersionsDiffUseCase } from './core/use-cases/compare-versions-diff.use-case';
import { LabelVersionUseCase } from './core/use-cases/label-version.use-case';
import { DeleteLabelUseCase } from './core/use-cases/delete-label.use-case';
import { RestoreVersionUseCase } from './core/use-cases/restore-version.use-case';

// Ports
import { IHistoryRepositoryPort } from './core/ports/history-repository.port';
import { IDiffEnginePort } from './core/ports/diff-engine.port';
import { IProjectCollectorPort } from './core/ports/project-collector.port';
import { IProjectRestorerPort } from './core/ports/project-restorer.port';

// Adapters
import { PrismaHistoryRepository } from './core/adapters/database/prisma-history.repository';
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

    // Use Cases
    CreateSnapshotUseCase,
    GetVersionListUseCase,
    GetSnapshotByVersionUseCase,
    CompareVersionsDiffUseCase,
    LabelVersionUseCase,
    DeleteLabelUseCase,
    RestoreVersionUseCase,

    // Driven Adapters
    PrismaHistoryRepository,
    MyersDiffEngineAdapter,
    ManuscriptCollectorAdapter,
    ManuscriptRestorerAdapter,

    // Ports SPI bindings
    {
      provide: IHistoryRepositoryPort,
      useClass: PrismaHistoryRepository,
    },
    {
      provide: IDiffEnginePort,
      useClass: MyersDiffEngineAdapter,
    },
    {
      provide: IProjectCollectorPort,
      useClass: ManuscriptCollectorAdapter,
    },
    {
      provide: IProjectRestorerPort,
      useClass: ManuscriptRestorerAdapter,
    },
  ],
  exports: [
    ProjectHistoryService,
    IHistoryRepositoryPort,
    IDiffEnginePort,
    IProjectCollectorPort,
    IProjectRestorerPort,
    CreateSnapshotUseCase,
    GetVersionListUseCase,
    GetSnapshotByVersionUseCase,
    CompareVersionsDiffUseCase,
    LabelVersionUseCase,
    DeleteLabelUseCase,
    RestoreVersionUseCase,
  ],
})
export class ProjectHistoryModule {}
