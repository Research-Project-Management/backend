import { Module } from '@nestjs/common';
import { FileModule } from './file/file.module';

@Module({
  imports: [FileModule],
  exports: [FileModule],
})
export class StorageModule {}

