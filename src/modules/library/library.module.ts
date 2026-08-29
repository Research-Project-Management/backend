import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from '../../core/core.module';
import { CatalogModule } from './catalog/catalog.module';
import { CollectionsModule } from './collections/collections.module';
import { TagsModule } from './tags/tags.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AnnotationsModule } from './annotations/annotations.module';
import { NotesModule } from './notes/notes.module';
import { StateModule } from './state/state.module';
import { SyncModule } from './sync/sync.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { CurationModule } from './curation/curation.module';
import { ExportsModule } from './exports/exports.module';

/**
 * Pure Composition Root for the Library Module.
 * Wires canonical business feature modules.
 */
@Module({
  imports: [
    ConfigModule,
    CoreModule,

    CatalogModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    StateModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    CurationModule,
    ExportsModule,
  ],
  exports: [
    CatalogModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    StateModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    CurationModule,
    ExportsModule,
  ],
})
export class LibraryModule {}
