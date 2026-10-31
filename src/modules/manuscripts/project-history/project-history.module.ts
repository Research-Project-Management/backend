/**
 * project-history/project-history.module.ts
 * NestJS Module for Manuscripts Project History, Snapshots, Diff & Labels (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
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
import { MyersDiffEngine } from './domain';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule, FilestoreModule],
  controllers: [ProjectHistoryController],
  providers: [
    ProjectHistoryService,
    ProjectHistoryRepository,
    MyersDiffEngine,
    ManuscriptCollectorAdapter,
    ManuscriptRestorerAdapter,
  ],
  exports: [
    ProjectHistoryService,
    ProjectHistoryRepository,
    ManuscriptCollectorAdapter,
    ManuscriptRestorerAdapter,
  ],
})
export class ProjectHistoryModule {}
