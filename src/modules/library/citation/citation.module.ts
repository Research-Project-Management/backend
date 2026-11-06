import { Global, Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';
import { CitationFacade, CITATION_FACADE } from './services/exports.service';

// Presentation
import { CitationController } from './controllers/citation.controller';
import { ExportsController } from './controllers/citation.controller';

// Services
import {
  CitationService,
  QueryResolverService,
} from './services/citation.service';
import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import {
  CslEngineService,
  CslLocaleLoaderService,
  CslStyleFormatterService,
} from './services/csl-engine.service';
import { TcvnCitationFormatterService } from './domain/tcvn-citation.domain';
import { CslRepositoryService } from './services/csl-repository.service';
import { ExportsService } from './services/exports.service';
import { PdfBakerService } from './services/pdf-baker.service';
import { ExportsRepository } from './repositories/exports.repository';

// Domain
import { CslStyleRegistry } from './domain/citation.domain';

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
@Global()
@Module({
  imports: [CoreModule, LibraryCoreModule],
  controllers: [CitationController, ExportsController],
  providers: [
    CitationFacade,
    {
      provide: CITATION_FACADE,
      useExisting: CitationFacade,
    },
    CslRepositoryService,
    CitationService,
    QueryResolverService,
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
  exports: [CITATION_FACADE, CitationFacade],
})
export class CitationModule {}
