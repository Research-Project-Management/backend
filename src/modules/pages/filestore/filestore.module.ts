/**
 * filestore/filestore.module.ts
 * NestJS Module for Manuscripts Filestore Subsystem.
 * Delegates physical binary storage to Flux's unified FilesModule (`FILES_PORT`)
 * via PlatformBinaryStorageAdapter.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilesModule } from '@/modules/files/files.module';
import { FILES_PORT } from '@/modules/files/files.constant';
import { type IFilesPort } from '@/modules/files/types/files.type';
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
        filesPort?: IFilesPort,
        platformAdapter?: PlatformBinaryStorageAdapter,
      ) => {
        if (filesPort && platformAdapter) {
          return platformAdapter;
        }
        return new LocalDiskBinaryStorageAdapter();
      },
      inject: [
        { token: FILES_PORT, optional: true },
        { token: PlatformBinaryStorageAdapter, optional: true },
      ],
    },
    FilestoreRepository,
    FilestoreService,
  ],
  exports: [FilestoreService, FilestoreRepository, IBinaryStoragePort],
})
export class FilestoreModule {}
