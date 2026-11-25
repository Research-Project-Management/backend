import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  PrismaModule,
  QUEUES,
  shouldMountTransferControllers,
  shouldRunWorkerConsumers,
} from '@/core';
import { FILES_PORT, STORAGE_ADAPTER } from './files.constant';
import { createStorageAdapter } from './adapters/adapter.factory';
import { BlobRepository } from './repositories/blob.repository';
import { QuotaRepository } from './repositories/quota.repository';
import { SessionRepository } from './repositories/session.repository';
import { FileAccessService } from './services/access.service';
import { BlobService } from './services/blob.service';
import { ThumbnailService } from './services/thumbnail.service';
import { FilesUploadService } from './services/upload.service';
import { CasProcessor } from './processors/cas.processor';
import { CleanupProcessor } from './processors/cleanup.processor';
import { MediaProcessor } from './processors/media.processor';
import { FilesController } from './controllers/files.controller';
import { LocalFilesController } from './controllers/local.controller';
import { FilesFacade } from './files.facade';

const filesControllers = shouldMountTransferControllers()
  ? [FilesController, LocalFilesController]
  : [];

const maintenanceWorkerProviders = shouldRunWorkerConsumers()
  ? [CleanupProcessor, MediaProcessor, CasProcessor]
  : [];

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue(
      { name: QUEUES.FILE_CLEANUP },
      { name: QUEUES.FILE_MEDIA },
      { name: QUEUES.FILE_CAS },
    ),
  ],
  controllers: filesControllers,
  providers: [
    {
      provide: STORAGE_ADAPTER,
      useFactory: (config: ConfigService) => createStorageAdapter(config),
      inject: [ConfigService],
    },
    BlobRepository,
    QuotaRepository,
    SessionRepository,
    BlobService,
    FilesUploadService,
    ThumbnailService,
    FileAccessService,
    ...maintenanceWorkerProviders,
    FilesFacade,
    {
      provide: FILES_PORT,
      useExisting: FilesFacade,
    },
  ],
  exports: [FilesFacade, FILES_PORT, STORAGE_ADAPTER],
})
export class FilesModule {}
