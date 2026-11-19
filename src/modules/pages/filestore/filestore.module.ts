/**
 * filestore/filestore.module.ts
 * NestJS Module for Manuscripts Filestore Subsystem.
 * Delegates physical binary storage to Flux's unified FilesModule (BlobService / STORAGE_ADAPTER)
 * via PlatformBinaryStorageAdapter.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import {
  FilesModule,
  STORAGE_ADAPTER,
  BlobService,
  IStorageAdapter,
} from '@/modules/files';
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
  imports: [ConfigModule, PrismaModule, FilesModule],
  controllers: [FilestoreController],
  providers: [
    ContentHasherAdapter,
    PlatformBinaryStorageAdapter,
    {
      provide: IBinaryStoragePort,
      useFactory: (
        blobService?: BlobService,
        storageAdapter?: IStorageAdapter,
      ) => {
        if (blobService || storageAdapter) {
          return new PlatformBinaryStorageAdapter(blobService, storageAdapter);
        }
        return new LocalDiskBinaryStorageAdapter();
      },
      inject: [
        { token: BlobService, optional: true },
        { token: STORAGE_ADAPTER, optional: true },
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
