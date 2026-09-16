import { Module } from '@nestjs/common';
import { ProjectAnalyticsController } from './analytics.controller';
import { ProjectAnalyticsService } from './analytics.service';
import { ProjectAnalyticsRepository } from './analytics.repository';

@Module({
  controllers: [ProjectAnalyticsController],
  providers: [ProjectAnalyticsService, ProjectAnalyticsRepository],
  exports: [ProjectAnalyticsService, ProjectAnalyticsRepository],
})
export class ProjectAnalyticsModule {}
