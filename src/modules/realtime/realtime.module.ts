/**
 * realtime/realtime.module.ts
 * Enterprise Root Real-Time Module (Global).
 * Aggregates domain realtime submodules (Manuscripts, Notifications, Collaboration).
 */

import { Module, Global } from '@nestjs/common';
import { ManuscriptsRealtimeModule } from './manuscripts/manuscripts-realtime.module';
import { NotificationsRealtimeModule } from './notifications/notifications-realtime.module';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [
    ManuscriptsRealtimeModule,
    NotificationsRealtimeModule,
  ],
  providers: [RealtimeService],
  exports: [
    RealtimeService,
    ManuscriptsRealtimeModule,
    NotificationsRealtimeModule,
  ],
})
export class RealtimeModule {}
