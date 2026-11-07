/**
 * filestore/filestore.module.ts
 * NestJS Module for Manuscripts Filestore Subsystem.
 * Delegates physical binary storage to Flux's unified @Global() StorageCoreModule (BlobService / STORAGE_DRIVER)
 * via PlatformBinaryStorageAdapter.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import {
  STORAGE_DRIVER,
  STORAGE_QUOTA_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { BlobService, IStorageDriver } from '@/modules/storage/core';
import { PrismaStorageQuotaRepository } from '@/modules/storage/drive';
import { FilestoreController } from './filestore.controller';
import { FilestoreService } from './filestore.service';
import {
  FilestoreRepository,
  PlatformBinaryStorageAdapter,
  LocalDiskBinaryStorageAdapter,
  ContentHasherAdapter,
} from './filestore.repository';
import { IBinaryStoragePort } from './filestore.types';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FilestoreController],
  providers: [
    ContentHasherAdapter,
    PlatformBinaryStorageAdapter,
    {
      provide: STORAGE_QUOTA_REPOSITORY,
      useClass: PrismaStorageQuotaRepository,
    },
    {
      provide: IBinaryStoragePort,
      useFactory: (
        blobService?: BlobService,
        storageDriver?: IStorageDriver,
      ) => {
        if (blobService || storageDriver) {
          return new PlatformBinaryStorageAdapter(blobService, storageDriver);
        }
        return new LocalDiskBinaryStorageAdapter();
      },
      inject: [
        { token: BlobService, optional: true },
        { token: STORAGE_DRIVER, optional: true },
      ],
    },
    FilestoreRepository,
    FilestoreService,
  ],
  exports: [
    FilestoreService,
    FilestoreRepository,
    ContentHasherAdapter,
    PlatformBinaryStorageAdapter,
    IBinaryStoragePort,
  ],
})
export class FilestoreModule {}
