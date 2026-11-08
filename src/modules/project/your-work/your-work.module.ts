import { Module } from '@nestjs/common';
import { YourWorkController } from './your-work.controller';
import { YourWorkService } from './your-work.service';
import { YourWorkRepository } from './your-work.repository';
import { ActivityModule } from '@/modules/activity/activity.module';

@Module({
  imports: [ActivityModule],
  controllers: [YourWorkController],
  providers: [YourWorkService, YourWorkRepository],
  exports: [YourWorkService, YourWorkRepository],
})
export class YourWorkModule {}
