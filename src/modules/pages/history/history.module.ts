/**
 * history/history.module.ts
 * NestJS Module for Pages History, Snapshots, Diff, Labels & Restore.
 */

import { Module } from '@nestjs/common';
import { PrismaModule, RedisModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { PagesCoreModule } from '@/modules/pages/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { FilestoreModule } from '@/modules/pages/filestore';
import { StructureModule } from '@/modules/pages/structure';

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
  imports: [
    PrismaModule,
    RedisModule,
    FilesModule,
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    FilestoreModule,
  ],
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
  ],
})
export class HistoryModule {}
