/**
 * modules/manuscripts/structure/structure.module.ts
 * NestJS Module for Manuscript Project File Tree & Hierarchy Subsystem.
 */

import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { StructureController } from './structure.controller';
import { StructureService } from './structure.service';

// Use Cases
import { GetFileTreeUseCase } from './core/use-cases/get-file-tree.use-case';
import { CreateNodeUseCase } from './core/use-cases/create-node.use-case';
import { MoveNodeUseCase } from './core/use-cases/move-node.use-case';
import { RenameNodeUseCase } from './core/use-cases/rename-node.use-case';
import { DeleteNodeUseCase } from './core/use-cases/delete-node.use-case';
import { ResolveRootDocUseCase } from './core/use-cases/resolve-root-doc.use-case';
import { BuildCompilerFilesUseCase } from './core/use-cases/build-compiler-files.use-case';

// Ports & Adapters
import { IStructureRepository } from './core/ports/structure-repository.port';
import { PrismaStructureRepository } from './core/adapters/database/prisma-structure.repository';
import { IRootDocDetector } from './core/ports/root-doc-detector.port';
import { HeuristicRootDocDetector } from './core/adapters/engine/heuristic-root-doc.detector';
import { ITreePublisher } from './core/ports/tree-publisher.port';
import { InMemoryTreePublisher } from './core/adapters/event/in-memory-tree.publisher';

@Module({
  imports: [PrismaModule],
  controllers: [StructureController],
  providers: [
    StructureService,
    GetFileTreeUseCase,
    CreateNodeUseCase,
    MoveNodeUseCase,
    RenameNodeUseCase,
    DeleteNodeUseCase,
    ResolveRootDocUseCase,
    BuildCompilerFilesUseCase,
    {
      provide: IStructureRepository,
      useClass: PrismaStructureRepository,
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
  exports: [
    StructureService,
    IStructureRepository,
    ResolveRootDocUseCase,
    BuildCompilerFilesUseCase,
  ],
})
export class StructureModule {}
