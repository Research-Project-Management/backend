import { Module } from '@nestjs/common';
import { CoreModule } from '../core/core.module';
import { NotificationGateway } from './notifications.gateway';

@Module({
  imports: [CoreModule],
  providers: [NotificationGateway],
  exports: [NotificationGateway],
})
export class NotificationsModule {}
