import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { ExtractorService, PdfExtractorService } from './extractor.service';
import { ItemsModule } from '../items/items.module';
import { AnnotationsModule } from '../annotations/annotations.module';
import { NotesModule } from '../notes/notes.module';

@Module({
  imports: [ItemsModule, AnnotationsModule, NotesModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, ExtractorService, PdfExtractorService],
  exports: [AttachmentsService, ExtractorService, PdfExtractorService],
})
export class AttachmentsModule {}
