import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { FileRepository } from './file.repository';
import { R2Service } from '../r2/r2.service';

@Module({
  controllers: [FileController],
  providers: [FileService, FileRepository, R2Service],
  exports: [FileService, FileRepository, R2Service],
})
export class FileModule {}
