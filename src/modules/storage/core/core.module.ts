import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  STORAGE_DRIVER,
  STORAGE_BLOB_REPOSITORY,
} from '@/modules/storage/storage.tokens';
import { createStorageDriver } from './services/driver.factory';
import { PrismaStorageBlobRepository } from './repositories/prisma-blob.repository';
import { StorageRedisCacheService } from './services/cache.service';
import { BlobService } from './services/blob.service';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      useFactory: (config: ConfigService) => createStorageDriver(config),
      inject: [ConfigService],
    },
    {
      provide: STORAGE_BLOB_REPOSITORY,
      useClass: PrismaStorageBlobRepository,
    },
    StorageRedisCacheService,
    BlobService,
  ],
  exports: [
    STORAGE_DRIVER,
    STORAGE_BLOB_REPOSITORY,
    StorageRedisCacheService,
    BlobService,
  ],
})
export class StorageCoreModule {}
