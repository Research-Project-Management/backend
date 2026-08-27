import { Module } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import { CoreModule } from '../../../core/core.module';
import { SyncCoreContextModule } from '../sync-core/sync-core.module';

@Module({
  imports: [CoreModule, SyncCoreContextModule],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsContextModule {}
