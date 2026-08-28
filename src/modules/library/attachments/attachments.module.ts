import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { ExtractorService } from './extractor.service';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  providers: [AttachmentsService, ExtractorService],
  exports: [AttachmentsService, ExtractorService],
})
export class AttachmentsContextModule {}
