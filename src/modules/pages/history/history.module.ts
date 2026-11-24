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
import { HistoryService } from './services/history.service';
import { HistoryRepository } from './repositories/history.repository';
import { SnapshotCollectorAdapter } from './adapters/snapshot-collector.adapter';
import { SnapshotRestorerAdapter } from './adapters/snapshot-restorer.adapter';
import { DiffEngine } from './domain/diff.domain';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule, FilestoreModule],
  controllers: [HistoryController],
  providers: [
    HistoryService,
    HistoryRepository,
    DiffEngine,
    SnapshotCollectorAdapter,
    SnapshotRestorerAdapter,
  ],
  exports: [
    HistoryService,
    HistoryRepository,
    SnapshotCollectorAdapter,
    SnapshotRestorerAdapter,
  ],
})
export class HistoryModule {}
