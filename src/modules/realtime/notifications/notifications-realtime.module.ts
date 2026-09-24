/**
 * realtime/notifications/notifications-realtime.module.ts
 * Submodule packaging Real-Time Notification Gateway and Event Emitters.
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { NotificationGateway } from './notifications.gateway';

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [NotificationGateway],
  exports: [NotificationGateway],
})
export class NotificationsRealtimeModule {}
