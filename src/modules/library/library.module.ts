import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '@/core';

// The 6 Canonical Symmetrical Microservices-Ready Modules
import { SyncModule } from './sync/sync.module';
import { CatalogModule } from './catalog/catalog.module';
import { ExtractionModule } from './extraction/extraction.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';

// Core (primitives, resilience & cross-cutting concerns)
import { LibraryCoreModule } from './core/core.module';

import { LibraryFacade, LIBRARY_FACADE } from './library.facade';

/**
 * Macro Composition Root for the Library Subsystem.
 *
 * Modular Monolith Architecture matching Manuscripts / Overleaf Scale (1M+ Users):
 * Consists of 6 Domain Sub-Modules + 1 Core Module + 1 Unified Facade:
 *
 * 1. SyncModule        — CDC, Outbox, Monotonic Sequence, TransactionService
 * 2. CatalogModule     — Metadata (37 CSL Types), OCC, Collections, Tags, Notes, Annotations
 * 3. ExtractionModule  — In-Process Trusted Extractor (XMP, Regex, Layout, MeXtract), OCR, Sandwich PDF, Claim-Check S3
 * 4. IngestionModule   — CrossRef/arXiv/PubMed Pipeline, Dedup, Retraction Watch
 * 5. SearchModule      — Postgres FTS, Semantic Vector, Event-driven Indexing
 * 6. CitationModule    — CSL Engine, 10k+ Styles, DOI Negotiation, Multi-format Exports
 * 7. LibraryCoreModule — Domain primitives, Zotero schema, resilience, security & middlewares
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    LibraryCoreModule,
    SyncModule,
    CatalogModule,
    ExtractionModule,
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
    LibraryFacade,
    LIBRARY_FACADE,
    LibraryCoreModule,
    SyncModule,
    CatalogModule,
    ExtractionModule,
    IngestionModule,
    SearchModule,
    CitationModule,
  ],
})
export class LibraryModule {}
