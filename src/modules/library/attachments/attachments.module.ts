import { Module, forwardRef } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { AnnotationsService } from './annotations/annotations.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { CatalogModule } from '../catalog/catalog.module';

@Module({
  imports: [forwardRef(() => CatalogModule)],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AnnotationsService, PdfExtractorService],
  exports: [AttachmentsService, AnnotationsService, PdfExtractorService],
})
export class AttachmentsModule {}
