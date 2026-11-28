/**
 * modules/pages/docstore/docstore.module.ts
 * NestJS Module bundling Pages Docstore controllers, services, repositories, and adapters.
 */

import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/pages/filestore';
import { UserResolverService } from '@/modules/pages/core';
import { PageModule } from '../page/page.module';
import { DocController } from './controllers/doc.controller';
import { DocSyncController } from './controllers/doc-sync.controller';
import { SearchReplaceController } from './controllers/search-replace.controller';
import { PresenceController } from './controllers/presence.controller';
import { DocstoreService } from './docstore.service';
import { PresenceService } from './services/presence.service';
import { SearchReplaceService } from './services/search-replace.service';

// Repositories & Adapters
import { DocstoreRepository } from './repositories/docstore.repository';
import { DocArchiveRepository } from './repositories/archive.repository';
import { IDocPersistor } from './domain/doc.ports';
import { ScopeRepository } from './repositories/scope.repository';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
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

    // Repositories & Cold-Tier Persistor Seam
    DocstoreRepository,
    DocArchiveRepository,
    { provide: IDocPersistor, useExisting: DocArchiveRepository },
    ScopeRepository,
  ],
  exports: [
    DocstoreService,
    UserResolverService,
    PresenceService,
    SearchReplaceService,
    DocstoreRepository,
    DocArchiveRepository,
    IDocPersistor,
    ScopeRepository,
  ],
})
export class DocstoreModule {}
