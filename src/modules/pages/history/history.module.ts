/**
 * project-history/history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';

import { HistoryController } from './controllers/history.controller';
import { PageVersionsController } from './controllers/versions.controller';
import { HistoryService } from './services/history.service';
import { PageVersionsService } from './services/versions.service';
import { HistoryRepository } from './repositories/history.repository';
import { PageSnapshotCollectorAdapter } from './adapters/snapshot-collector.adapter';
import { PageSnapshotRestorerAdapter } from './adapters/snapshot-restorer.adapter';
import { DiffEngine } from './domain/diff.domain';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule, FilestoreModule],
  controllers: [HistoryController, PageVersionsController],
  providers: [
    HistoryService,
    PageVersionsService,
    HistoryRepository,
    DiffEngine,
    PageSnapshotCollectorAdapter,
    PageSnapshotRestorerAdapter,
  ],
  exports: [
    HistoryService,
    PageVersionsService,
    HistoryRepository,
    PageSnapshotCollectorAdapter,
    PageSnapshotRestorerAdapter,
  ],
})
export class HistoryModule {}
