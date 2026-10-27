/**
 * modules/manuscripts/docstore/docstore.module.ts
 * NestJS Module bundling Manuscripts Docstore controllers, services, repositories, and adapters.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { ProjectHistoryModule } from '@/modules/manuscripts/project-history/project-history.module';
import { TrackChangesModule } from '@/modules/manuscripts/track-changes/track-changes.module';
import { ExportImportModule } from '@/modules/manuscripts/export-import/export-import.module';
import {
  PagesDocController,
  PagesReviewController,
  PagesHistoryExportController,
  PagesSearchPresenceController,
} from './controllers';
import { DocstoreService } from './docstore.service';
import { ManuscriptPageService } from '../core/services/manuscript-page.service';
import { ManuscriptUserResolverService } from './services/manuscript-user-resolver.service';
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
  imports: [
    ConfigModule,
    PrismaModule,
    FilestoreModule,
    forwardRef(() => StructureModule),
    forwardRef(() => ProjectHistoryModule),
    forwardRef(() => TrackChangesModule),
    forwardRef(() => ExportImportModule),
  ],
  controllers: [
    PagesDocController,
    PagesReviewController,
    PagesHistoryExportController,
    PagesSearchPresenceController,
  ],
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
