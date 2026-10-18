import { Module } from '@nestjs/common';
import { UPLOAD_SESSION_REPOSITORY } from '@/modules/storage/storage.tokens';
import { PrismaUploadSessionRepository } from './repositories/prisma-session.repository';

import {
  DirectUploadService,
  PresignService,
  CompletePresignService,
} from './services/upload.service';
import { MultipartService } from './services/multipart.service';
import { StreamService } from './services/stream.service';

import { UploadController } from './controllers/upload.controller';
import { StreamController } from './controllers/stream.controller';
import { StorageDriveModule } from '../drive/drive.module';
import { shouldMountTransferControllers } from '@/core';

const transferControllers = shouldMountTransferControllers()
  ? [UploadController, StreamController]
  : [];

@Module({
  imports: [StorageDriveModule],
  controllers: transferControllers,
  providers: [
    {
      provide: UPLOAD_SESSION_REPOSITORY,
      useClass: PrismaUploadSessionRepository,
    },
    DirectUploadService,
    PresignService,
    CompletePresignService,
    MultipartService,
    StreamService,
  ],
  exports: [
    UPLOAD_SESSION_REPOSITORY,
    DirectUploadService,
    PresignService,
    CompletePresignService,
    MultipartService,
    StreamService,
  ],
})
export class StorageTransferModule {}
