import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CitationModule } from '../citation/citation.module';
import { CatalogModule } from '../catalog/catalog.module';
import { ExportsService } from './exports.service';
import { PdfExportService } from './pdf-export.service';
import { ExportsController } from './exports.controller';

@Module({
  imports: [CoreModule, CitationModule, CatalogModule],
  controllers: [ExportsController],
  providers: [ExportsService, PdfExportService],
  exports: [ExportsService, PdfExportService],
})
export class ExportsModule {}
