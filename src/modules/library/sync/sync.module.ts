import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';
import { CollectionsModule } from '../collections/collections.module';
import { ItemsModule } from '../items/items.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { NotesModule } from '../notes/notes.module';
import { AnnotationsModule } from '../annotations/annotations.module';
import { SYNC_PORT } from './ports/sync.port';
import { SyncService } from './sync.service';

@Module({
  imports: [
    CoreModule,
    OutboxModule,
    CollectionsModule,
    ItemsModule,
    AttachmentsModule,
    NotesModule,
    AnnotationsModule,
  ],
  controllers: [SyncController],
  providers: [
    IdempotencyRepository,
    SyncService,
    {
      provide: SYNC_PORT,
      useExisting: SyncService,
    },
  ],
  exports: [SYNC_PORT, SyncService],
})
export class SyncModule {}

