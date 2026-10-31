/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { PagesDocController } from './controllers/doc.controller';
import { PagesSearchPresenceController } from './controllers/search-presence.controller';
import { DocstoreService } from './docstore.service';
import { ManuscriptPageService } from '../core/services/page.service';
import { ManuscriptUserResolverService } from '../core/services/user-resolver.service';
import { ManuscriptPresenceService } from './services/presence.service';
import { ManuscriptSearchReplaceService } from './services/search-replace.service';
import { ManuscriptProjectBootstrapService } from './services/bootstrap.service';

// Repositories & Adapters
import { DocstoreRepository } from './repositories/docstore.repository';
import {
  DocArchiveRepository,
  StoragePortDocArchiveAdapter,
} from './repositories/archive.repository';
import {
  DocHasherAdapter,
  IDocRepository,
  IDocPersistor,
  IDocHasher,
} from './domain';
import { ManuscriptPageScopeRepository } from './repositories/scope.repository';

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
    { provide: IDocRepository, useExisting: DocstoreRepository },
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    { provide: IDocPersistor, useExisting: StoragePortDocArchiveAdapter },
    DocHasherAdapter,
    { provide: IDocHasher, useExisting: DocHasherAdapter },
    ManuscriptPageScopeRepository,
  ],
  exports: [
    ManuscriptPageService,
    DocstoreService,
    ManuscriptUserResolverService,
    ManuscriptPresenceService,
    ManuscriptSearchReplaceService,
    ManuscriptProjectBootstrapService,
    DocstoreRepository,
    IDocRepository,
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    IDocPersistor,
    DocHasherAdapter,
    IDocHasher,
    ManuscriptPageScopeRepository,
  ],
})
export class DocstoreModule {}
