import { Module } from '@nestjs/common';
import { AnnotationsController } from './annotations.controller';
import { AnnotationsService } from './annotations.service';
import { AnnotationsRepository } from './annotations.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [CoreModule, OutboxModule],
  controllers: [AnnotationsController],
  providers: [AnnotationsRepository, AnnotationsService],
  exports: [AnnotationsService],
})
export class AnnotationsModule {}
