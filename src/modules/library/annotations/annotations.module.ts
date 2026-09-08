import { Module } from '@nestjs/common';
import { AnnotationsController } from './annotations.controller';
import { AnnotationsService } from './annotations.service';
import { AnnotationsRepository } from './annotations.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  imports: [CoreModule, OutboxModule, AttachmentsModule],
  controllers: [AnnotationsController],
  providers: [AnnotationsRepository, AnnotationsService],
  exports: [AnnotationsService],
})
export class AnnotationsModule {}
