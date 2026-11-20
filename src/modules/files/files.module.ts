import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  PrismaModule,
  shouldMountTransferControllers,
  shouldRunWorkerConsumers,
} from '@/core';
import {
  FILES_FINALIZE_CAS_QUEUE,
  FILES_MAINTENANCE_QUEUE,
  FILES_MEDIA_QUEUE,
  FILES_PORT,
  STORAGE_ADAPTER,
} from './files.constant';
import { createStorageAdapter } from './adapters/adapter.factory';
import { BlobRepository } from './repositories/blob.repository';
import { QuotaRepository } from './repositories/quota.repository';
import { SessionRepository } from './repositories/session.repository';
import { FileAccessService } from './services/access.service';
import { BlobService } from './services/blob.service';
import { ThumbnailService } from './services/thumbnail.service';
import { FilesUploadService } from './services/upload.service';
import { FilesFinalizeCasProcessor } from './processors/files-finalize-cas.processor';
import { FilesMaintenanceProcessor } from './processors/files-maintenance.processor';
import { FilesMediaProcessor } from './processors/files-media.processor';
import { FilesController } from './controllers/files.controller';
import { LocalFilesController } from './controllers/local.controller';
import { FilesFacade } from './files.facade';

const filesControllers = shouldMountTransferControllers()
  ? [FilesController, LocalFilesController]
  : [];

const maintenanceWorkerProviders = shouldRunWorkerConsumers()
  ? [FilesMaintenanceProcessor, FilesMediaProcessor, FilesFinalizeCasProcessor]
  : [];

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    BullModule.registerQueue(
      { name: FILES_MAINTENANCE_QUEUE },
      { name: FILES_MEDIA_QUEUE },
      { name: FILES_FINALIZE_CAS_QUEUE },
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
