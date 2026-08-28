import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from '../../core/core.module';
import { LibraryFeatureFlagsService } from './common/library-feature-flags';
import { CatalogContextModule } from './catalog/catalog.module';
import { CollectionsContextModule } from './collections/collections.module';
import { TagsContextModule } from './tags/tags.module';
import { AttachmentsContextModule } from './attachments/attachments.module';
import { AnnotationsContextModule } from './annotations/annotations.module';
import { NotesContextModule } from './notes/notes.module';
import { SyncCoreContextModule } from './sync-core/sync-core.module';
import { DiscoveryContextModule } from './discovery/discovery.module';
import { CitationContextModule } from './citation/citation.module';
import { IngestionContextModule } from './ingestion/ingestion.module';
import { CurationContextModule } from './curation/curation.module';
import { ExportsContextModule } from './exports/exports.module';
import { LegacyLibraryModule } from './legacy/module';

/**
 * Pure Composition Root for the Canonical Library Module.
 * Wires submodules, providers, feature flags, and legacy compatibility module.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    CoreModule,

    CatalogContextModule,
    CollectionsContextModule,
    TagsContextModule,
    AttachmentsContextModule,
    AnnotationsContextModule,
    NotesContextModule,
    SyncCoreContextModule,
    DiscoveryContextModule,
    CitationContextModule,
    IngestionContextModule,
    CurationContextModule,
    ExportsContextModule,

    // Compatibility routes and providers
    LegacyLibraryModule,
  ],
  providers: [LibraryFeatureFlagsService],
  exports: [
    LibraryFeatureFlagsService,

    CatalogContextModule,
    CollectionsContextModule,
    TagsContextModule,
    AttachmentsContextModule,
    AnnotationsContextModule,
    NotesContextModule,
    SyncCoreContextModule,
    DiscoveryContextModule,
    CitationContextModule,
    IngestionContextModule,
    CurationContextModule,
    ExportsContextModule,
  ],
})
export class LibraryModule {}
