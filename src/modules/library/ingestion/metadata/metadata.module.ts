import { Module } from '@nestjs/common';
import { CoreModule } from '@/core/core.module';
import {
  METADATA_PROVIDERS,
  METADATA_PORT,
  MetadataProvider,
} from './types/metadata.types';
import { MetadataCache } from './cache/metadata.cache';
import { ReconciliationService } from './services/reconciliation.service';
import { ProviderExecutor } from './services/provider.executor';
import { MetadataService } from './metadata.service';

import { CrossRefProvider } from './providers/crossref.provider';
import { ArxivProvider } from './providers/arxiv.provider';
import { PubMedProvider } from './providers/pubmed.provider';
import { OpenLibraryProvider } from './providers/openlibrary.provider';
import { SemanticScholarProvider } from './providers/semantic-scholar.provider';
import { OpenAlexProvider } from './providers/openalex.provider';
import { UnpaywallProvider } from './providers/unpaywall.provider';

@Module({
  imports: [CoreModule],
  providers: [
    MetadataCache,
    ReconciliationService,
    ProviderExecutor,
    CrossRefProvider,
    ArxivProvider,
    PubMedProvider,
    OpenLibraryProvider,
    SemanticScholarProvider,
    OpenAlexProvider,
    UnpaywallProvider,
    {
      provide: METADATA_PROVIDERS,
      useFactory: (
        crossref: CrossRefProvider,
        arxiv: ArxivProvider,
        pubmed: PubMedProvider,
        openlibrary: OpenLibraryProvider,
        semantic: SemanticScholarProvider,
        openalex: OpenAlexProvider,
        unpaywall: UnpaywallProvider,
      ): MetadataProvider[] => [
        crossref,
        arxiv,
        pubmed,
        openlibrary,
        semantic,
        openalex,
        unpaywall,
      ],
      inject: [
        CrossRefProvider,
        ArxivProvider,
        PubMedProvider,
        OpenLibraryProvider,
        SemanticScholarProvider,
        OpenAlexProvider,
        UnpaywallProvider,
      ],
    },
    MetadataService,
    {
      provide: METADATA_PORT,
      useExisting: MetadataService,
    },
  ],
  // Keep implementation details private. Callers cross the canonical seam via
  // METADATA_PORT only.
  exports: [METADATA_PORT],
})
export class MetadataModule {}
