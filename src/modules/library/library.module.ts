import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule } from '../../core/core.module';
import { ItemsModule } from './items/items.module';
import { TypesModule } from './types/types.module';
import { CurationModule } from './curation/curation.module';
import { CollectionsModule } from './collections/collections.module';
import { TagsModule } from './tags/tags.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AnnotationsModule } from './annotations/annotations.module';
import { NotesModule } from './notes/notes.module';
import { ReadingModule } from './reading/reading.module';
import { SyncModule } from './sync/sync.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ExportsModule } from './exports/exports.module';
import { OutboxModule } from './outbox/outbox.module';

/**
 * Pure Composition Root for the Library Module.
 * Wires canonical 15 single-word business feature modules.
 */
@Module({
  imports: [
    ConfigModule,
    CoreModule,

    ItemsModule,
    TypesModule,
    CurationModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    ReadingModule,
    OutboxModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    ExportsModule,
  ],
  exports: [
    ItemsModule,
    TypesModule,
    CurationModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    ReadingModule,
    OutboxModule,
    SyncModule,
    SearchModule,
    CitationModule,
    IngestionModule,
    ExportsModule,
  ],
})
export class LibraryModule {}
