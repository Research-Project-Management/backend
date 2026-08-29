import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';
import { StorageAdapter } from '../storage.adapter';
import { STORAGE_PORT } from '../storage.port';

@Module({
  controllers: [FileController],
  providers: [
    FileService,
    FileRepository,
    R2Service,
    StorageAdapter,
    {
      provide: STORAGE_PORT,
      useExisting: StorageAdapter,
    },
  ],
  exports: [FileService, FileRepository, R2Service, STORAGE_PORT],
})
export class FileModule {}
