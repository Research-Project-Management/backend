import { Module } from '@nestjs/common';
import { AnnotationsController } from './annotations.controller';
import { AnnotationsService } from './annotations.service';
import { AnnotationsRepository } from './annotations.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  controllers: [AnnotationsController],
  providers: [AnnotationsRepository, AnnotationsService],
  exports: [AnnotationsRepository, AnnotationsService],
})
export class AnnotationsContextModule {}
