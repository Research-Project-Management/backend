/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import {
  PagesDocController,
  PagesReviewController,
  PagesHistoryExportController,
  PagesSearchPresenceController,
} from './controllers';
import { DocstoreService } from './docstore.service';
import { PageExportTranspilerService } from './services/page-export-transpiler.service';
import { ManuscriptUserResolverService } from './services/manuscript-user-resolver.service';
import { ManuscriptTextMutatorService } from './services/manuscript-text-mutator.service';
import { ManuscriptPresenceService } from './services/manuscript-presence.service';
import { ManuscriptSearchReplaceService } from './services/manuscript-search-replace.service';
import { ManuscriptProjectBootstrapService } from './services/manuscript-project-bootstrap.service';

// Repositories & Adapters
import {
  DocstoreRepository,
  PrismaDocRepository,
} from './repositories/docstore.repository';
import {
  DocArchiveRepository,
  S3DocPersistorAdapter,
} from './repositories/doc-archive.repository';
import { DocHasherAdapter } from './core/adapters/engine/doc-hasher.adapter';

// Tokens
import { IDocRepository } from './core/ports/doc-repository.port';
import { IDocPersistor } from './core/ports/doc-persistor.port';
import { IDocHasher } from './core/ports/doc-hasher.port';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [
    PagesDocController,
    PagesReviewController,
    PagesHistoryExportController,
    PagesSearchPresenceController,
  ],
  providers: [
    // 7 Domain Services
    DocstoreService,
    PageExportTranspilerService,
    ManuscriptUserResolverService,
    ManuscriptTextMutatorService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,

    // 2 Repositories & Adapters
    DocstoreRepository,
    PrismaDocRepository,
    DocArchiveRepository,
    S3DocPersistorAdapter,
    DocHasherAdapter,

    // Token Bindings
    {
      provide: IDocRepository,
      useExisting: DocstoreRepository,
    },
    {
      provide: IDocPersistor,
      useExisting: DocArchiveRepository,
    },
    {
      provide: IDocHasher,
      useExisting: DocHasherAdapter,
    },
  ],
  exports: [
    DocstoreService,
    PageExportTranspilerService,
    ManuscriptUserResolverService,
    ManuscriptTextMutatorService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,
    DocstoreRepository,
    PrismaDocRepository,
    DocArchiveRepository,
    S3DocPersistorAdapter,
    IDocRepository,
    IDocPersistor,
    IDocHasher,
  ],
})
export class DocstoreModule {}
