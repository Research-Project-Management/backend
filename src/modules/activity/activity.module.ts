import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityRepository } from './activity.repository';
import { ActivityListener } from './activity.listener';
import { CacheModule } from '@/core/cache/cache.module';

@Module({
  imports: [CacheModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityRepository, ActivityListener],
  exports: [ActivityService, ActivityRepository],
})
export class ActivityModule {}
