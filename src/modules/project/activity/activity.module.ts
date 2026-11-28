import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityService } from './activity.service';
import { ActivityRepository } from './activity.repository';
import { ActivityListener } from './activity.listener';
import { RedisModule } from '@/core';

@Module({
  imports: [RedisModule],
  controllers: [ActivityController],
  providers: [ActivityService, ActivityRepository, ActivityListener],
  exports: [ActivityService],
})
export class ActivityModule {}
