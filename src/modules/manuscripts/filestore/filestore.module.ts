/**
 * filestore/filestore.module.ts
 * NestJS Module for Manuscripts Filestore Subsystem.
 */

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '@/core';
import { FilestoreController } from './filestore.controller';
import { FilestoreService } from './filestore.service';
import { FilestoreRepository } from './filestore.repository';

// Ports & Adapters
import { IBinaryStoragePort } from './core/ports/binary-storage.port';
import { IManuscriptFileRepository } from './core/ports/manuscript-file-repository.port';
import { IContentHasherPort } from './core/ports/content-hasher.port';
import { LocalDiskBinaryStorageAdapter } from './core/adapters/storage/local-disk-binary-storage.adapter';
import { S3BinaryStorageAdapter } from './core/adapters/storage/s3-binary-storage.adapter';
import { CryptoGitBlobHasherAdapter } from './core/adapters/engine/crypto-git-blob-hasher.adapter';

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
        const s3Key = configService.get<string>('AWS_ACCESS_KEY_ID');
        const s3Endpoint = configService.get<string>('AWS_ENDPOINT');
        const forceLocal =
          configService.get<string>('MANUSCRIPTS_FILESTORE_DRIVER') === 'local';

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
