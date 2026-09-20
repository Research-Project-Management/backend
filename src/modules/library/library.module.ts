import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../core/core.module';

// Bounded Context Modules
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { BibliographyModule } from './bibliography/bibliography.module';
import { ReaderModule } from './reader/reader.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';

import { LibraryFacade, LIBRARY_FACADE } from './library.facade';

/**
 * Macro Composition Root for the Library Module.
 *
 * Clean Architecture & Strategic DDD structure:
 * Consists of exactly 5 Bounded Contexts + 1 Shared Kernel + 1 Unified Facade:
 * 1. BibliographyModule (Core Domain — Items, Collections, Tags, Types, State, Saved Searches)
 * 2. ReaderModule (Supporting Domain — Attachments, Annotations, Notes, OCR)
 * 3. IngestionModule (Supporting Domain — Ingestion Pipeline, Metadata Resolution, Curation, Retraction)
 * 4. SearchModule (Generic Domain — Postgres FTS, Local Semantic Vector Search, RAG Retrieval)
 * 5. CitationModule (Supporting Domain — CSL Engine, Citation Formatting, DOI Negotiation, Exports, PDF Baker)
 * 6. SharedKernelModule (Shared Infrastructure, Outbox, Integration Event Bus)
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,

    // Bounded Contexts
    SharedKernelModule,
    BibliographyModule,
    ReaderModule,
    IngestionModule,
    SearchModule,
    CitationModule,
  ],
  providers: [
    LibraryFacade,
    {
      provide: LIBRARY_FACADE,
      useExisting: LibraryFacade,
    },
  ],
  exports: [
    // Public Facades
    LibraryFacade,
    LIBRARY_FACADE,

    // Bounded Context Modules
    SharedKernelModule,
    BibliographyModule,
    ReaderModule,
    IngestionModule,
    SearchModule,
    CitationModule,
  ],
})
export class LibraryModule {}
