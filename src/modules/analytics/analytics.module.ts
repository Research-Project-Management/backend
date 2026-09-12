import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository } from './analytics.repository';
import { YourWorkModule } from './your-work/your-work.module';
import { CacheModule } from '@/core/cache/cache.module';

@Module({
  imports: [YourWorkModule, CacheModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsRepository],
  exports: [AnalyticsService, YourWorkModule],
})
export class AnalyticsModule {}
