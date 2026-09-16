import { Module } from '@nestjs/common';
import { ArchiveController } from './archive.controller';
import { ArchiveService } from './archive.service';
import { ArchiveRepository } from './archive.repository';
import { CoreRepository } from '../core/core.repository';

@Module({
  controllers: [ArchiveController],
  providers: [ArchiveService, ArchiveRepository, CoreRepository],
  exports: [ArchiveService, ArchiveRepository],
})
export class ArchiveModule {}
