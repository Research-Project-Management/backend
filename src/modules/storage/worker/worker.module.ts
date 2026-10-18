import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { STORAGE_PROCESSING_QUEUE } from './types';
import { StorageQueueProducer } from './services/queue.producer';
import { StorageQueueConsumer } from './services/queue.consumer';
import { PdfThumbnailService } from './services/pdf-thumbnail.service';
import { StorageBackupService } from './services/backup.service';
import {
  StorageLifecycleService,
  TrashRetentionJob,
  MultipartCleanupJob,
  OrphanBlobJob,
} from './services/lifecycle.service';
import { StorageEventOutboxService } from './services/outbox.service';
import { shouldRunWorkerConsumers } from '@/core';
import { StorageDriveModule } from '../drive/drive.module';
import { StorageTransferModule } from '../transfer/transfer.module';

const storageWorkerProviders = shouldRunWorkerConsumers()
  ? [StorageQueueConsumer]
  : [];

@Module({
  imports: [
    StorageDriveModule,
    StorageTransferModule,
    BullModule.registerQueue({
      name: STORAGE_PROCESSING_QUEUE,
    }),
  ],
  providers: [
    StorageQueueProducer,
    ...storageWorkerProviders,
    PdfThumbnailService,
    StorageBackupService,
    StorageLifecycleService,
    StorageEventOutboxService,
    TrashRetentionJob,
    MultipartCleanupJob,
    OrphanBlobJob,
  ],
  exports: [
    StorageQueueProducer,
    PdfThumbnailService,
    StorageBackupService,
    StorageLifecycleService,
    StorageEventOutboxService,
  ],
})
export class StorageWorkerModule {}
