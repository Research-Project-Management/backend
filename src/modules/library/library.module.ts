import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CoreModule as AppCoreModule } from '../../core/core.module';

// The 6 Canonical Symmetrical Microservices-Ready Modules
import { SyncModule } from './sync/sync.module';
import { CatalogModule } from './catalog/catalog.module';
import { ExtractionModule } from './extraction/extraction.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SearchModule } from './search/search.module';
import { CitationModule } from './citation/citation.module';

// Shared Kernel (lean infrastructure & cross-cutting concerns)
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';

import { LibraryFacade, LIBRARY_FACADE } from './library.facade';

/**
 * Macro Composition Root for the Library Subsystem.
 *
 * Microservices-Ready Architecture matching Manuscripts / Overleaf Scale (1M+ Users):
 * Consists of exactly 6 Symmetrical Modules + 1 Shared Kernel + 1 Unified Facade:
 *
 * 1. SyncModule    — CDC, Outbox, Monotonic Sequence, TransactionService
 * 2. CatalogModule — Metadata (37 CSL Types), OCC, Collections, Tags, Notes, Annotations
 * 3. ExtractionModule — In-Process Trusted Extractor (XMP, Regex, Layout, MeXtract), OCR, Sandwich PDF, Claim-Check S3
 * 4. IngestionModule  — CrossRef/arXiv/PubMed Pipeline, Dedup, Retraction Watch
 * 5. SearchModule     — Postgres FTS, Semantic Vector, Event-driven Indexing
 * 6. CitationModule   — CSL Engine, 10k+ Styles, DOI Negotiation, Multi-format Exports
 *
 * Note: BibliographyModule and ReaderModule are no longer needed — consumers
 * should import CatalogModule (or ExtractionModule) directly or use LibraryFacade.
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    SharedKernelModule,
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
    SharedKernelModule,
    SyncModule,
    CatalogModule,
    ExtractionModule,
    IngestionModule,
    SearchModule,
    CitationModule,
  ],
})
export class LibraryModule {}
