/**
 * modules/manuscripts/structure/structure.module.ts
 * NestJS Module for Manuscript Project File Tree & Hierarchy Subsystem (Adaptive Modular Monolith).
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';
import { StructureRepository } from './structure.repository';
import { IStructureRepository } from './core/ports/structure-repository.port';
import { IRootDocDetector } from './core/ports/root-doc-detector.port';
import { HeuristicRootDocDetector } from './core/adapters/engine/heuristic-root-doc.detector';
import { ITreePublisher } from './core/ports/tree-publisher.port';
import { InMemoryTreePublisher } from './core/adapters/event/in-memory-tree.publisher';

@Module({
  imports: [PrismaModule, FilestoreModule],
  controllers: [StructureController],
  providers: [
    StructureService,
    StructureRepository,
    {
      provide: IStructureRepository,
      useExisting: StructureRepository,
    },
    {
      provide: IRootDocDetector,
      useClass: HeuristicRootDocDetector,
    },
    {
      provide: ITreePublisher,
      useClass: InMemoryTreePublisher,
    },
  ],
  exports: [StructureService, StructureRepository, IStructureRepository],
})
export class StructureModule {}
