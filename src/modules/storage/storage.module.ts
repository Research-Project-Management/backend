import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  STORAGE_DRIVER,
  STORAGE_NODE_REPOSITORY,
  STORAGE_BLOB_REPOSITORY,
  UPLOAD_SESSION_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_PORT,
} from './storage.tokens';

// Infrastructure: Drivers & Persistence
import { createStorageDriver } from './infrastructure/drivers/driver.factory';
import { PrismaStorageNodeRepository } from './infrastructure/persistence/prisma-storage-node.repository';
import { PrismaStorageBlobRepository } from './infrastructure/persistence/prisma-storage-blob.repository';
import { PrismaUploadSessionRepository } from './infrastructure/persistence/prisma-upload-session.repository';
import { PrismaStorageQuotaRepository } from './infrastructure/persistence/prisma-storage-quota.repository';
import { StorageRedisCacheService } from './infrastructure/cache/storage-redis-cache.service';

// Application: Policies & Use Cases
import { StorageAccessPolicy } from './application/policies/storage-access.policy';
import { UploadDirectUseCase } from './application/use-cases/upload/upload-direct.use-case';
import { PresignUploadUseCase } from './application/use-cases/upload/presign-upload.use-case';
import { MultipartUploadUseCase } from './application/use-cases/upload/multipart-upload.use-case';
import { ListDriveUseCase } from './application/use-cases/drive/list-drive.use-case';
import { MoveNodeUseCase } from './application/use-cases/drive/move-node.use-case';
import { SoftDeleteUseCase } from './application/use-cases/trash/soft-delete.use-case';
import { RestoreNodeUseCase } from './application/use-cases/trash/restore-node.use-case';
import { PermanentDeleteUseCase } from './application/use-cases/trash/permanent-delete.use-case';
import { StreamBinaryUseCase } from './application/use-cases/stream/stream-binary.use-case';
import { CheckQuotaUseCase } from './application/use-cases/quota/check-quota.use-case';

// Application: Cron Jobs
import { TrashRetentionJob } from './application/jobs/trash-retention.cron';
import { MultipartCleanupJob } from './application/jobs/multipart-cleanup.cron';
import { OrphanBlobJob } from './application/jobs/orphan-blob.cron';

// Presentation: Controllers
import { DriveController } from './presentation/controllers/drive.controller';
import { UploadController } from './presentation/controllers/upload.controller';
import { StreamController } from './presentation/controllers/stream.controller';
import { TrashController } from './presentation/controllers/trash.controller';
import { QuotaController } from './presentation/controllers/quota.controller';

// Facade (Public API)
import { StorageFacade } from './storage.facade';
import { R2Service } from './infrastructure/drivers/r2.service';

@Global()
@Module({
  controllers: [
    DriveController,
    UploadController,
    StreamController,
    TrashController,
    QuotaController,
  ],
  providers: [
    // 1. Storage Driver Factory & Compatibility R2Service
    {
      provide: STORAGE_DRIVER,
      useFactory: (config: ConfigService) => createStorageDriver(config),
      inject: [ConfigService],
    },
    R2Service,

    // 2. Repositories
    {
      provide: STORAGE_NODE_REPOSITORY,
      useClass: PrismaStorageNodeRepository,
    },
    {
      provide: STORAGE_BLOB_REPOSITORY,
      useClass: PrismaStorageBlobRepository,
    },
    {
      provide: UPLOAD_SESSION_REPOSITORY,
      useClass: PrismaUploadSessionRepository,
    },
    {
      provide: STORAGE_QUOTA_REPOSITORY,
      useClass: PrismaStorageQuotaRepository,
    },

    // 3. Cache & Policy
    StorageRedisCacheService,
    StorageAccessPolicy,

    // 4. Use Cases
    UploadDirectUseCase,
    PresignUploadUseCase,
    MultipartUploadUseCase,
    ListDriveUseCase,
    MoveNodeUseCase,
    SoftDeleteUseCase,
    RestoreNodeUseCase,
    PermanentDeleteUseCase,
    StreamBinaryUseCase,
    CheckQuotaUseCase,

    // 5. Background Jobs
    TrashRetentionJob,
    MultipartCleanupJob,
    OrphanBlobJob,

    // 6. Public Facade & Legacy Port
    StorageFacade,
    {
      provide: STORAGE_PORT,
      useExisting: StorageFacade,
    },
  ],
  exports: [
    StorageFacade,
    R2Service,
    STORAGE_PORT,
    STORAGE_DRIVER,
    STORAGE_NODE_REPOSITORY,
    STORAGE_BLOB_REPOSITORY,
  ],
})
export class StorageModule {}
