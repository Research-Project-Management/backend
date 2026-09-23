/**
 * filestore/filestore.module.ts
 * NestJS Composition Root for Manuscripts Filestore Subsystem (Hexagonal Architecture).
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '@/core/database/prisma.module';
import { FilestoreController } from './filestore.controller';
import { FilestoreService } from './filestore.service';

// Use Cases
import { UploadManuscriptFileUseCase } from './core/use-cases/upload-manuscript-file.use-case';
import { StreamManuscriptFileUseCase } from './core/use-cases/stream-manuscript-file.use-case';
import { GetManuscriptFileHeadUseCase } from './core/use-cases/get-manuscript-file-head.use-case';
import { DeleteManuscriptFileUseCase } from './core/use-cases/delete-manuscript-file.use-case';
import { GetSignedDownloadUrlUseCase } from './core/use-cases/get-signed-download-url.use-case';

// Ports
import { IBinaryStoragePort } from './core/ports/binary-storage.port';
import { IManuscriptFileRepository } from './core/ports/manuscript-file-repository.port';
import { IContentHasherPort } from './core/ports/content-hasher.port';

// Adapters
import { LocalDiskBinaryStorageAdapter } from './core/adapters/storage/local-disk-binary-storage.adapter';
import { S3BinaryStorageAdapter } from './core/adapters/storage/s3-binary-storage.adapter';
import { PrismaManuscriptFileRepository } from './core/adapters/database/prisma-manuscript-file.repository';
import { CryptoGitBlobHasherAdapter } from './core/adapters/engine/crypto-git-blob-hasher.adapter';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [FilestoreController],
  providers: [
    FilestoreService,
    UploadManuscriptFileUseCase,
    StreamManuscriptFileUseCase,
    GetManuscriptFileHeadUseCase,
    DeleteManuscriptFileUseCase,
    GetSignedDownloadUrlUseCase,
    {
      provide: IManuscriptFileRepository,
      useClass: PrismaManuscriptFileRepository,
    },
    {
      provide: IContentHasherPort,
      useClass: CryptoGitBlobHasherAdapter,
    },
    {
      provide: IBinaryStoragePort,
      useFactory: (configService: ConfigService) => {
        const s3Key = configService.get<string>('AWS_ACCESS_KEY_ID');
        const s3Endpoint = configService.get<string>('AWS_ENDPOINT');
        const forceLocal = configService.get<string>('MANUSCRIPTS_FILESTORE_DRIVER') === 'local';

        if (forceLocal || (!s3Key && !s3Endpoint)) {
          return new LocalDiskBinaryStorageAdapter();
        }
        return new S3BinaryStorageAdapter(configService);
      },
      inject: [ConfigService],
    },
  ],
  exports: [
    FilestoreService,
    IBinaryStoragePort,
    IManuscriptFileRepository,
    IContentHasherPort,
  ],
})
export class FilestoreModule {}
