import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule, shouldMountTransferControllers } from '@/core';
import {
  FILES_PORT,
  STORAGE_ADAPTER,
  STORAGE_BLOB_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
} from './files.constant';
import { createStorageAdapter } from './adapters/adapter.factory';
import { BlobRepository } from './repositories/blob.repository';
import { QuotaRepository } from './repositories/quota.repository';
import { SessionRepository } from './repositories/session.repository';
import { BlobService } from './services/blob.service';
import { QuotaService } from './services/quota.service';
import { PresignService } from './services/presign.service';
import { FileStreamService } from './services/stream.service';
import { ThumbnailService } from './services/thumbnail.service';
import { FilesController } from './controllers/files.controller';
import { LocalFilesController } from './controllers/local.controller';
import { FilesFacade } from './files.facade';

const filesControllers = shouldMountTransferControllers()
  ? [FilesController, LocalFilesController]
  : [];

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: filesControllers,
  providers: [
    {
      provide: STORAGE_ADAPTER,
      useFactory: (config: ConfigService) => createStorageAdapter(config),
      inject: [ConfigService],
    },
    {
      provide: STORAGE_BLOB_REPOSITORY,
      useClass: BlobRepository,
    },
    {
      provide: STORAGE_QUOTA_REPOSITORY,
      useClass: QuotaRepository,
    },
    {
      provide: UPLOAD_SESSION_REPOSITORY,
      useClass: SessionRepository,
    },
    BlobService,
    QuotaService,
    PresignService,
    FileStreamService,
    ThumbnailService,
    FilesFacade,
    {
      provide: FILES_PORT,
      useExisting: FilesFacade,
    },
  ],
  exports: [
    FilesFacade,
    FILES_PORT,
    BlobService,
    QuotaService,
    PresignService,
    FileStreamService,
    ThumbnailService,
    STORAGE_ADAPTER,
    STORAGE_BLOB_REPOSITORY,
    STORAGE_QUOTA_REPOSITORY,
    UPLOAD_SESSION_REPOSITORY,
  ],
})
export class FilesModule {}
