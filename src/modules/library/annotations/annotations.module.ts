import { Module } from '@nestjs/common';
import { AnnotationsController } from './annotations.controller';
import { AnnotationsService } from './annotations.service';
import { AnnotationsRepository } from './annotations.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [CoreModule, SyncModule],
  controllers: [AnnotationsController],
  providers: [AnnotationsRepository, AnnotationsService],
  exports: [AnnotationsService],
})
export class AnnotationsModule {}
