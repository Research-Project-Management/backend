import { Module } from '@nestjs/common';
import { AnnotationsController } from './annotations.controller';
import { AnnotationsService } from './annotations.service';
import { AnnotationsRepository } from './annotations.repository';
import { AnnotationNormalizer } from './normalizers/annotation.normalizer';
import { PdfAnnotationImporterService } from './services/pdf-annotation-importer.service';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [CoreModule, OutboxModule, AttachmentsModule, StorageModule],
  controllers: [AnnotationsController],
  providers: [
    AnnotationsRepository,
    AnnotationsService,
    AnnotationNormalizer,
    PdfAnnotationImporterService,
  ],
  exports: [
    AnnotationsService,
    AnnotationNormalizer,
    PdfAnnotationImporterService,
  ],
})
export class AnnotationsModule {}
