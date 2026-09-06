import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { ItemsModule } from '../items/items.module';
import { MetadataModule } from '../ingestion/metadata/metadata.module';
import { CitationService } from './citation.service';
import { CitationController } from './citation.controller';

import { DoiContentNegotiationService } from './services/doi-content-negotiation.service';
import { CslEngineService } from './services/csl-engine.service';

@Module({
  imports: [CoreModule, ItemsModule, MetadataModule],
  controllers: [CitationController],
  providers: [CitationService, DoiContentNegotiationService, CslEngineService],
  exports: [CitationService, DoiContentNegotiationService, CslEngineService],
})
export class CitationModule {}
