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
import { ManuscriptUserResolverService } from './services/manuscript-user-resolver.service';
import { ManuscriptPresenceService } from './services/manuscript-presence.service';
import { ManuscriptSearchReplaceService } from './services/manuscript-search-replace.service';
import { ManuscriptProjectBootstrapService } from './services/manuscript-project-bootstrap.service';

// Repositories & Adapters
import { DocstoreRepository } from './repositories/docstore.repository';
import { DocArchiveRepository } from './repositories/doc-archive.repository';
import {
  DocHasherAdapter,
  IDocRepository,
  IDocPersistor,
  IDocHasher,
} from './domain';
import { ManuscriptPageScopeRepository } from './repositories/manuscript-page-scope.repository';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [
    PagesDocController,
    PagesReviewController,
    PagesHistoryExportController,
    PagesSearchPresenceController,
  ],
  providers: [
    // Domain Services
    DocstoreService,
    ManuscriptUserResolverService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,

    // Repositories & Adapters
    DocstoreRepository,
    DocArchiveRepository,
    DocHasherAdapter,
    ManuscriptPageScopeRepository,

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
    ManuscriptUserResolverService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,
    DocstoreRepository,
    DocArchiveRepository,
    ManuscriptPageScopeRepository,
    IDocRepository,
    IDocPersistor,
    IDocHasher,
  ],
})
export class DocstoreModule {}
