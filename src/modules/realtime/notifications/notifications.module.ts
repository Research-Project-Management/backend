import { Module } from '@nestjs/common';
import { RealtimeCoreModule } from '../core/core.module';
import { NotificationGateway } from './notifications.gateway';

@Module({
  imports: [RealtimeCoreModule],
  providers: [NotificationGateway],
  exports: [NotificationGateway],
})
export class RealtimeNotificationsModule {}
export { RealtimeNotificationsModule as NotificationsModule };
