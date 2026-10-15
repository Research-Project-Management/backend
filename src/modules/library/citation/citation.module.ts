import { Module } from '@nestjs/common';
import { CoreModule } from '@/core';
import { CatalogModule } from '@/modules/library/catalog/catalog.module';
import { CitationFacade, CITATION_FACADE } from './citation.facade';

// Presentation
import { CitationController } from './controllers/citation.controller';
import { ExportsController } from './controllers/exports.controller';

// Services
import { CitationService } from './services/citation.service';
import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import { CslEngineService } from './services/csl-engine.service';
import { CslRepositoryService } from './services/csl-repository.service';
import { ExportsService } from './services/exports.service';
import { PdfBakerService } from './services/pdf-baker.service';
import { ExportsRepository } from './repositories/exports.repository';

// Utils & Gateways
import { CslStyleRegistry } from './domain/csl-style-registry';
import { InProcessCatalogGatewayAdapter } from './gateways/in-process-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter } from './gateways/http-catalog-gateway.adapter';

// Ports/Types
import { CATALOG_GATEWAY_PORT } from './types/citation.types';

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
    InProcessCatalogGatewayAdapter,
    HttpCatalogGatewayAdapter,
    {
      provide: CATALOG_GATEWAY_PORT,
      useFactory: (
        inProcess: InProcessCatalogGatewayAdapter,
        http: HttpCatalogGatewayAdapter,
      ) => {
        return process.env.LIBRARY_CATALOG_URL ? http : inProcess;
      },
      inject: [InProcessCatalogGatewayAdapter, HttpCatalogGatewayAdapter],
    },
  ],
  exports: [
    CitationFacade,
    CITATION_FACADE,
    CslRepositoryService,
    CitationService,
    ExportsService,
  ],
})
export class CitationModule {}
