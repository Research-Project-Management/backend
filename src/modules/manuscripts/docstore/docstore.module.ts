/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { PagesDocController } from './controllers/pages-doc.controller';
import { PagesSearchPresenceController } from './controllers/pages-search-presence.controller';
import { DocstoreService } from './docstore.service';
import { ManuscriptPageService } from '../core/services/manuscript-page.service';
import { ManuscriptUserResolverService } from '../core/services/manuscript-user-resolver.service';
import { ManuscriptPresenceService } from './services/manuscript-presence.service';
import { ManuscriptSearchReplaceService } from './services/manuscript-search-replace.service';
import { ManuscriptProjectBootstrapService } from './services/manuscript-project-bootstrap.service';

// Repositories & Adapters
import { DocstoreRepository } from './repositories/docstore.repository';
import {
  DocArchiveRepository,
  StoragePortDocArchiveAdapter,
} from './repositories/doc-archive.repository';
import {
  DocHasherAdapter,
  IDocRepository,
  IDocPersistor,
  IDocHasher,
} from './domain';
import { ManuscriptPageScopeRepository } from './repositories/manuscript-page-scope.repository';

@Module({
  imports: [ConfigModule, PrismaModule, FilestoreModule],
  controllers: [PagesDocController, PagesSearchPresenceController],
  providers: [
    // Domain Services
    ManuscriptPageService,
    DocstoreService,
    ManuscriptUserResolverService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,

    // Repositories & Adapters
    DocstoreRepository,
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    DocHasherAdapter,
    ManuscriptPageScopeRepository,

    // Token Bindings
    {
      provide: IDocRepository,
      useExisting: DocstoreRepository,
    },
    {
      provide: IDocPersistor,
      useClass: StoragePortDocArchiveAdapter,
    },
    {
      provide: IDocHasher,
      useExisting: DocHasherAdapter,
    },
  ],
  exports: [
    ManuscriptPageService,
    DocstoreService,
    ManuscriptUserResolverService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,
    DocstoreRepository,
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    ManuscriptPageScopeRepository,
    IDocRepository,
    IDocPersistor,
    IDocHasher,
  ],
})
export class DocstoreModule {}
