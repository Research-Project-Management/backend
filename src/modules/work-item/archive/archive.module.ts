import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { ArchiveController } from './archive.controller';
import { ArchiveRepository } from './archive.repository';
import { ArchiveService } from './archive.service';

@Module({
  imports: [PrismaModule],
  controllers: [ArchiveController],
  providers: [ArchiveRepository, ArchiveService],
  exports: [ArchiveService, ArchiveRepository],
})
export class ArchiveModule {}
