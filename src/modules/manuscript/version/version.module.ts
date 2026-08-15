import { Module } from '@nestjs/common';
import { VersionController } from './version.controller';
import { VersionService } from './version.service';
import { VersionRepository } from './version.repository';

@Module({
  controllers: [VersionController],
  providers: [VersionService, VersionRepository],
  exports: [VersionService, VersionRepository],
})
export class VersionModule {}
