import { Module } from '@nestjs/common';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { OverviewRepository } from './overview.repository';

@Module({
  controllers: [OverviewController],
  providers: [OverviewService, OverviewRepository],
  exports: [OverviewService, OverviewRepository],
})
export class OverviewModule {}
