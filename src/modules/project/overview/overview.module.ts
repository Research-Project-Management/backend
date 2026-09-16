import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';
import { OverviewRepository } from './overview.repository';

@Module({
  controllers: [OverviewController],
  providers: [OverviewService, OverviewRepository, PrismaClient],
  exports: [OverviewService, OverviewRepository],
})
export class OverviewModule {}
