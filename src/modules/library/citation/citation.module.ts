import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CitationFacade, CITATION_FACADE } from './citation.facade';

// Presentation
import { CitationController } from './citation.controller';
import { ExportsController } from './exports.controller';

import { CitationService } from './core/use-cases/citation.service';
import { DoiContentNegotiationService } from './core/adapters/doi-content-negotiation.service';
import { CslEngineService } from './core/adapters/csl-engine.service';
import { CslRepositoryService } from './core/adapters/csl-repository.service';
import { CslStyleRegistry } from './core/adapters/csl-style-registry';
import { ExportsService } from './core/use-cases/exports.service';
import { PdfBakerService } from './core/adapters/pdf-baker.service';
import { FormatCitationUseCase } from './core/use-cases/format-citation.use-case';
import { ExportLibraryUseCase } from './core/use-cases/export-library.use-case';
import { ExportBibliographyUseCase } from './core/use-cases/export-bibliography.use-case';
import { ExportAnnotatedPdfUseCase } from './core/use-cases/export-annotated-pdf.use-case';
import { CslCitationEngineAdapter } from './core/adapters/csl-citation-engine.adapter';
import { CITATION_ENGINE_PORT } from './core/ports/citation-engine.port';
import { ExportsRepository } from './core/adapters/exports.repository';
import { CATALOG_GATEWAY_PORT } from './core/ports/catalog-gateway.port';
import { InProcessCatalogGatewayAdapter } from './core/adapters/in-process-catalog-gateway.adapter';

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
    DoiContentNegotiationService,
    CslEngineService,
    CslStyleRegistry,
    ExportsService,
    ExportsRepository,
    PdfBakerService,
    CslCitationEngineAdapter,
    {
      provide: CITATION_ENGINE_PORT,
      useClass: CslCitationEngineAdapter,
    },
    InProcessCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useClass: InProcessCatalogGatewayAdapter,
    },
    FormatCitationUseCase,
    ExportLibraryUseCase,
    ExportBibliographyUseCase,
    ExportAnnotatedPdfUseCase,
  ],
  exports: [
    CitationFacade,
    CITATION_FACADE,
    CslRepositoryService,
    CitationService,
    ExportsService,
    ExportsRepository,
    CITATION_ENGINE_PORT,
    FormatCitationUseCase,
    ExportLibraryUseCase,
    ExportBibliographyUseCase,
    ExportAnnotatedPdfUseCase,
  ],
})
export class CitationModule {}
