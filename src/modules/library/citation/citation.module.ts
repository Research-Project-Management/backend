import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CitationService } from './citation.service';
import { CitationController } from './citation.controller';

import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import { CslEngineService } from './services/csl-engine.service';

@Module({
  imports: [CoreModule, CatalogModule],
  controllers: [CitationController],
  providers: [CitationService, DoiContentNegotiationService, CslEngineService],
  exports: [CitationService, DoiContentNegotiationService, CslEngineService],
})
export class CitationModule {}
