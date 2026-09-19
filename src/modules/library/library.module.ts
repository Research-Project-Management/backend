import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../core/core.module';
import { CoreModule } from './core/core.module';
import { ItemsModule } from './items/items.module';
import { CurationModule } from './curation/curation.module';
import { CollectionsModule } from './collections/collections.module';
import { TagsModule } from './tags/tags.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AnnotationsModule } from './annotations/annotations.module';
import { NotesModule } from './notes/notes.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { OutboxModule } from './outbox/outbox.module';
import { SavedSearchesModule } from './saved-searches/saved-searches.module';

import { TypesModule } from './types/types.module';
import { StateModule } from './state/state.module';
import { ExportsModule } from './exports/exports.module';
import { RetractionModule } from './retraction/retraction.module';
import { InfraModule } from './infra/infra.module';
import { LibraryFacade, LIBRARY_FACADE } from './library.facade';

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
    InfraModule,

    TypesModule,
    ItemsModule,
    StateModule,
    CurationModule,
    RetractionModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    OutboxModule,
    SearchModule,
    CitationModule,
    ExportsModule,
    IngestionModule,
    SavedSearchesModule,
  ],
  providers: [
    LibraryFacade,
    {
      provide: LIBRARY_FACADE,
      useExisting: LibraryFacade,
    },
  ],
  exports: [
    LibraryFacade,
    LIBRARY_FACADE,
    CoreModule,
    InfraModule,
    TypesModule,
    ItemsModule,
    StateModule,
    CurationModule,
    RetractionModule,
    CollectionsModule,
    TagsModule,
    AttachmentsModule,
    AnnotationsModule,
    NotesModule,
    OutboxModule,
    SearchModule,
    CitationModule,
    ExportsModule,
    IngestionModule,
    SavedSearchesModule,
  ],
})
export class LibraryModule {}
