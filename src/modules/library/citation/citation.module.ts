import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CitationService } from './citation.service';
import { CitationController } from './citation.controller';

@Module({
  imports: [CoreModule, CatalogModule],
  controllers: [CitationController],
  providers: [CitationService],
  exports: [CitationService],
})
export class CitationModule {}
