/**
 * history/history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff, Labels & Restore.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';

import { HistoryController } from './history.controller';
import { SnapshotService } from './services/snapshot.service';
import { DiffService } from './services/diff.service';
import { LabelService } from './services/label.service';
import { RestoreService } from './services/restore.service';
import { MaintenanceService } from './services/maintenance.service';
import { HistoryRepository } from './history.repository';
import { SnapshotCollectorAdapter } from './adapters/collector.adapter';
import { SnapshotRestorerAdapter } from './adapters/restorer.adapter';
import { DiffEngine } from './domain/diff';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule, FilestoreModule],
  controllers: [HistoryController],
  providers: [
    SnapshotService,
    DiffService,
    LabelService,
    RestoreService,
    MaintenanceService,
    HistoryRepository,
    DiffEngine,
    SnapshotCollectorAdapter,
    SnapshotRestorerAdapter,
  ],
  exports: [
    SnapshotService,
    DiffService,
    LabelService,
    RestoreService,
    MaintenanceService,
    HistoryRepository,
    SnapshotCollectorAdapter,
    SnapshotRestorerAdapter,
  ],
})
export class HistoryModule {}
