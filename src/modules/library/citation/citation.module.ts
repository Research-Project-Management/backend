import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { BibliographyModule } from '../bibliography/bibliography.module';
import { CitationFacade, CITATION_FACADE } from './citation.facade';

// Presentation
import { CitationController } from './presentation/citation.controller';
import { ExportsController } from './presentation/exports.controller';

import { CitationService } from './application/services/citation.service';
import { DoiContentNegotiationService } from './application/services/doi-content-negotiation.service';
import { CslEngineService } from './application/services/csl-engine.service';
import { CslRepositoryService } from './application/services/csl-repository.service';
import { CslStyleRegistry } from './application/formatters/csl-style-registry';
import { ExportsService } from './application/services/exports.service';
import { PdfBakerService } from './application/services/pdf-baker.service';
import { FormatCitationUseCase } from './application/queries/format-citation.use-case';
import { ExportLibraryUseCase } from './application/queries/export-library.use-case';
import { ExportBibliographyUseCase } from './application/queries/export-bibliography.use-case';
import { ExportAnnotatedPdfUseCase } from './application/queries/export-annotated-pdf.use-case';
import { CslCitationEngineAdapter } from './infrastructure/adapters/csl-citation-engine.adapter';
import { CITATION_ENGINE_PORT } from './domain/ports/citation-engine.port';
import { ExportsRepository } from './infrastructure/repositories/exports.repository';

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
  imports: [CoreModule, BibliographyModule],
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
