import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../core/core.module';
import { CoreModule } from './core/core.module';
import { ItemsModule } from './items/items.module';
import { TypesModule } from './types/types.module';
import { CurationModule } from './curation/curation.module';
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
import { ExportsModule } from './exports/exports.module';
import { OutboxModule } from './outbox/outbox.module';

/**
 * Pure Composition Root for the Library Module.
 * Wires canonical feature modules and the central CoreModule.
 * Exposes LibraryFacade for clean, decoupled inter-module queries.
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    CoreModule,

    ItemsModule,
    TypesModule,
    CurationModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    StateModule,
    OutboxModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    ExportsModule,
  ],
  exports: [
    CoreModule,
    ItemsModule,
    TypesModule,
    CurationModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    OutboxModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    ExportsModule,
  ],
})
export class LibraryModule {}
