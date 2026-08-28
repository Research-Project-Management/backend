import { Module } from '@nestjs/common';
import { CoreModule } from '@/core/core.module';
import {
  CANONICAL_METADATA_PROVIDERS,
  CANONICAL_METADATA_SERVICE,
  MetadataProvider,
} from './metadata.contracts';
import { MetadataCache } from './metadata.cache';
import { MetadataReconciliationService } from './metadata.reconciler';
import { ProviderExecutor } from './metadata.executor';
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
    MetadataReconciliationService,
    ProviderExecutor,
    CrossRefProvider,
    ArxivProvider,
    PubMedProvider,
    OpenLibraryProvider,
    SemanticScholarProvider,
    OpenAlexProvider,
    UnpaywallProvider,
    {
      provide: CANONICAL_METADATA_PROVIDERS,
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
      provide: CANONICAL_METADATA_SERVICE,
      useExisting: MetadataService,
    },
  ],
  // Keep implementation details private. Callers cross the canonical seam via
  // CANONICAL_METADATA_SERVICE only.
  exports: [CANONICAL_METADATA_SERVICE],
})
export class MetadataModule {}
