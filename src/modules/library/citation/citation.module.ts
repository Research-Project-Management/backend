import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { CatalogModule } from '@/modules/library/catalog/catalog.module';
import { CitationFacade, CITATION_FACADE } from './citation.facade';

// Presentation
import { CitationController } from './controllers/citation.controller';
import { ExportsController } from './controllers/exports.controller';

// Services
import {
  CitationService,
  AcademicQueryResolverService,
} from './services/citation.service';
import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import {
  CslEngineService,
  CslLocaleLoaderService,
  CslStyleFormatterService,
} from './services/csl-engine.service';
import { TcvnCitationFormatterService } from './services/tcvn-citation-formatter.service';
import { CslRepositoryService } from './services/csl-repository.service';
import { ExportsService } from './services/exports.service';
import { PdfBakerService } from './services/pdf-baker.service';
import { ExportsRepository } from './repositories/exports.repository';

// Domain
import { CslStyleRegistry } from './domain/csl-style-registry';

/**
 * Citation Bounded Context Unified Module (Supporting Domain).
 *
 * Dedicated strictly to Academic Citation & Publishing:
 * - CSL (Citation Style Language) Execution Engine
 * - Citation Formatting across 10,000+ Journal Styles (APA, IEEE, Nature, Harvard...)
 * - Dynamic CSL Repository & Style Catalog Fetcher
 * - DOI Content Negotiation
 * - Bibliography & Library Exporting (BibTeX, RIS, CSV, CSL-JSON)
 * - PDF Annotation Baking
 */
@Module({
  imports: [CoreModule, CatalogModule],
  controllers: [CitationController, ExportsController],
  providers: [
    CitationFacade,
    {
      provide: CITATION_FACADE,
      useExisting: CitationFacade,
    },
    CslRepositoryService,
    CitationService,
    AcademicQueryResolverService,
    DoiContentNegotiationService,
    CslEngineService,
    CslLocaleLoaderService,
    CslStyleFormatterService,
    TcvnCitationFormatterService,
    CslStyleRegistry,
    ExportsService,
    ExportsRepository,
    PdfBakerService,
  ],
  exports: [
    CitationFacade,
    CITATION_FACADE,
    CslRepositoryService,
    CitationService,
    AcademicQueryResolverService,
    CslEngineService,
    CslLocaleLoaderService,
    CslStyleFormatterService,
    TcvnCitationFormatterService,
    ExportsService,
  ],
})
export class CitationModule {}
