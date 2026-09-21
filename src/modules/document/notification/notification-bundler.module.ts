import { Module } from '@nestjs/common';
import { NotificationBundlerController } from './notification-bundler.controller';
import { NotificationBundlerService } from './notification-bundler.service';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [CollaborationModule],
  controllers: [NotificationBundlerController],
  providers: [NotificationBundlerService],
  exports: [NotificationBundlerService],
})
export class NotificationBundlerModule {}
