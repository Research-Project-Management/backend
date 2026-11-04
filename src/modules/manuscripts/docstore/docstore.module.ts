/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { DocController } from './controllers/doc.controller';
import { SearchPresenceController } from './controllers/search-presence.controller';
import { DocstoreService } from './docstore.service';
import { PageService } from '../core/services/page.service';
import { UserResolverService } from '../core/services/user-resolver.service';
import { PresenceService } from './services/presence.service';
import { SearchReplaceService } from './services/search-replace.service';
import { BootstrapService } from './services/bootstrap.service';

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
import { ScopeRepository } from './repositories/scope.repository';

@Module({
  imports: [ConfigModule, PrismaModule, FilestoreModule],
  controllers: [DocController, SearchPresenceController],
  providers: [
    // Domain Services
    PageService,
    DocstoreService,
    UserResolverService,
    PresenceService,
    SearchReplaceService,
    BootstrapService,

    // Repositories & Adapters
    DocstoreRepository,
    { provide: IDocRepository, useExisting: DocstoreRepository },
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    { provide: IDocPersistor, useExisting: StoragePortDocArchiveAdapter },
    DocHasherAdapter,
    { provide: IDocHasher, useExisting: DocHasherAdapter },
    ScopeRepository,
  ],
  exports: [
    PageService,
    DocstoreService,
    UserResolverService,
    PresenceService,
    SearchReplaceService,
    BootstrapService,
    DocstoreRepository,
    IDocRepository,
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    IDocPersistor,
    DocHasherAdapter,
    IDocHasher,
    ScopeRepository,
  ],
})
export class DocstoreModule {}
