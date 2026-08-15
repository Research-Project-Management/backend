import { Module } from '@nestjs/common';
import { FileModule } from './file/file.module';
import { LabelModule } from './label/label.module';

@Module({
  imports: [FileModule, LabelModule],
  exports: [FileModule, LabelModule],
})
export class StorageModule {}
