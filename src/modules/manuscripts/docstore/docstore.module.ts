/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore services and adapters.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core/database/prisma.module';
import { DocstoreController } from './docstore.controller';
import { PagesBridgeController } from './pages-bridge.controller';
import { DocstoreService } from './docstore.service';

// Use Cases
import { GetDocUseCase } from './core/use-cases/get-doc.use-case';
import { PeekDocUseCase } from './core/use-cases/peek-doc.use-case';
import { UpdateDocUseCase } from './core/use-cases/update-doc.use-case';
import { PatchDocUseCase } from './core/use-cases/patch-doc.use-case';
import { GetAllDocsUseCase } from './core/use-cases/get-all-docs.use-case';
import { ArchiveProjectUseCase } from './core/use-cases/archive-project.use-case';

// Adapters
import { PrismaDocRepository } from './core/adapters/database/prisma-doc.repository';
import { S3DocPersistorAdapter } from './core/adapters/storage/s3-doc-persistor.adapter';
import { DocHasherAdapter } from './core/adapters/engine/doc-hasher.adapter';

// Tokens
import { IDocRepository } from './core/ports/doc-repository.port';
import { IDocPersistor } from './core/ports/doc-persistor.port';
import { IDocHasher } from './core/ports/doc-hasher.port';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [DocstoreController, PagesBridgeController],
  providers: [
    DocstoreService,
    GetDocUseCase,
    PeekDocUseCase,
    UpdateDocUseCase,
    PatchDocUseCase,
    GetAllDocsUseCase,
    ArchiveProjectUseCase,
    {
      provide: IDocRepository,
      useClass: PrismaDocRepository,
    },
    {
      provide: IDocPersistor,
      useClass: S3DocPersistorAdapter,
    },
    {
      provide: IDocHasher,
      useClass: DocHasherAdapter,
    },
    PrismaDocRepository,
    S3DocPersistorAdapter,
    DocHasherAdapter,
  ],
  exports: [
    DocstoreService,
    GetAllDocsUseCase,
    IDocRepository,
    PrismaDocRepository,
  ],
})
export class DocstoreModule {}
