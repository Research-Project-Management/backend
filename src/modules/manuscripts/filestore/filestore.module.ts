/**
 * filestore/filestore.module.ts
 * NestJS Module for Manuscripts Filestore Subsystem.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreController } from './filestore.controller';
import { FilestoreService } from './filestore.service';
import {
  FilestoreRepository,
  LocalDiskBinaryStorageAdapter,
  S3BinaryStorageAdapter,
  CryptoGitBlobHasherAdapter,
} from './filestore.repository';
import {
  IBinaryStoragePort,
  IManuscriptFileRepository,
  IContentHasherPort,
} from './filestore.types';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FilestoreController],
  providers: [
    CryptoGitBlobHasherAdapter,
    {
      provide: IContentHasherPort,
      useExisting: CryptoGitBlobHasherAdapter,
    },
    {
      provide: IBinaryStoragePort,
      useFactory: (configService: ConfigService) => {
        const driver = configService
          .get<string>('MANUSCRIPTS_FILESTORE_DRIVER')
          ?.toLowerCase();
        const storageDriver = configService
          .get<string>('STORAGE_DRIVER')
          ?.toLowerCase();
        const s3Key =
          configService.get<string>('AWS_ACCESS_KEY_ID') ||
          configService.get<string>('R2_ACCESS_KEY');
        const s3Endpoint =
          configService.get<string>('AWS_ENDPOINT') ||
          configService.get<string>('S3_ENDPOINT') ||
          configService.get<string>('R2_API_URL');
        const forceLocal = driver === 'local' || storageDriver === 'local';

        if (forceLocal || (!s3Key && !s3Endpoint)) {
          return new LocalDiskBinaryStorageAdapter();
        }
        return new S3BinaryStorageAdapter(configService);
      },
      inject: [ConfigService],
    },
    FilestoreRepository,
    {
      provide: IManuscriptFileRepository,
      useExisting: FilestoreRepository,
    },
    FilestoreService,
  ],
  exports: [
    FilestoreService,
    FilestoreRepository,
    IBinaryStoragePort,
    IManuscriptFileRepository,
    IContentHasherPort,
  ],
})
export class FilestoreModule {}
