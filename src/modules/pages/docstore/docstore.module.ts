/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { PageModule } from '../page/page.module';
import { DocController } from './controllers/doc.controller';
import { DocSyncController } from './controllers/doc-sync.controller';
import { SearchReplaceController } from './controllers/search-replace.controller';
import { PresenceController } from './controllers/presence.controller';
import { DocstoreService } from './docstore.service';
import { UserResolverService } from '../core/services/user-resolver.service';
import { PresenceService } from './services/presence.service';
import { SearchReplaceService } from './services/search-replace.service';

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
  imports: [
    ConfigModule,
    PrismaModule,
    FilesModule,
    FilestoreModule,
    forwardRef(() => PageModule),
  ],
  controllers: [
    DocController,
    DocSyncController,
    SearchReplaceController,
    PresenceController,
  ],
  providers: [
    // Domain Services
    DocstoreService,
    UserResolverService,
    PresenceService,
    SearchReplaceService,

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
    DocstoreService,
    UserResolverService,
    PresenceService,
    SearchReplaceService,
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
