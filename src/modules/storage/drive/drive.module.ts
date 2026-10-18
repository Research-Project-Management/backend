import { Module } from '@nestjs/common';
import {
  STORAGE_NODE_REPOSITORY,
  STORAGE_QUOTA_REPOSITORY,
  STORAGE_VERSION_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { PrismaStorageNodeRepository } from './repositories/prisma-node.repository';
import { PrismaStorageQuotaRepository } from './repositories/prisma-quota.repository';
import { PrismaStorageVersionRepository } from './repositories/prisma-version.repository';

import { DriveService, TrashService, QuotaService } from './services/drive.service';
import { VersionService } from './services/version.service';
import { StorageAccessPolicy } from './services/access.policy';

import {
  DriveController,
  TrashController,
  QuotaController,
} from './controllers/drive.controller';
import { VersionController } from './controllers/version.controller';
import { shouldMountDriveControllers } from '@/core';

const driveControllers = shouldMountDriveControllers()
  ? [DriveController, TrashController, QuotaController, VersionController]
  : [];

@Module({
  controllers: driveControllers,
  providers: [
    {
      provide: STORAGE_NODE_REPOSITORY,
      useClass: PrismaStorageNodeRepository,
    },
    {
      provide: STORAGE_QUOTA_REPOSITORY,
      useClass: PrismaStorageQuotaRepository,
    },
    {
      provide: STORAGE_VERSION_REPOSITORY,
      useClass: PrismaStorageVersionRepository,
    },
    DriveService,
    TrashService,
    QuotaService,
    VersionService,
    StorageAccessPolicy,
  ],
  exports: [
    STORAGE_NODE_REPOSITORY,
    STORAGE_QUOTA_REPOSITORY,
    STORAGE_VERSION_REPOSITORY,
    DriveService,
    TrashService,
    QuotaService,
    VersionService,
    StorageAccessPolicy,
  ],
})
export class StorageDriveModule {}
