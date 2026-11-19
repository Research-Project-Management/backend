/**
 * project-history/project-history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';

import { ProjectHistoryController } from './project-history.controller';
import { PageVersionsController } from './controllers/page-versions.controller';
import { ProjectHistoryService } from './project-history.service';
import { PageVersionsService } from './services/page-versions.service';
import { ProjectHistoryRepository } from './project-history.repository';
import {
  PageSnapshotCollectorAdapter,
  PageSnapshotRestorerAdapter,
} from './adapters/project-history.adapters';
import { DiffEngine } from './domain';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule, FilestoreModule],
  controllers: [ProjectHistoryController, PageVersionsController],
  providers: [
    ProjectHistoryService,
    PageVersionsService,
    ProjectHistoryRepository,
    DiffEngine,
    PageSnapshotCollectorAdapter,
    PageSnapshotRestorerAdapter,
  ],
  exports: [
    ProjectHistoryService,
    PageVersionsService,
    ProjectHistoryRepository,
    PageSnapshotCollectorAdapter,
    PageSnapshotRestorerAdapter,
  ],
})
export class ProjectHistoryModule {}
