import { Module } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { CitationModule } from '../citation/citation.module';
import { ItemsModule } from '../items/items.module';
import { AnnotationsModule } from '../annotations/annotations.module';
import { ExportsService } from './exports.service';
import { ExportsController } from './exports.controller';
import { PdfBakerService } from './services/pdf-baker.service';

@Module({
  imports: [CoreModule, CitationModule, ItemsModule, AnnotationsModule],
  controllers: [ExportsController],
  providers: [ExportsService, PdfBakerService],
  exports: [ExportsService, PdfBakerService],
})
export class ExportsModule {}
