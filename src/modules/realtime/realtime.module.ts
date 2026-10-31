import { Module, Global } from '@nestjs/common';
import { RealtimeCoreModule } from './core/core.module';
import { RealtimeManuscriptsModule } from './manuscripts/manuscripts.module';
import { RealtimeNotificationsModule } from './notifications/notifications.module';
import { RealtimeFacade } from './realtime.facade';

@Global()
@Module({
  imports: [
    RealtimeCoreModule,
    RealtimeManuscriptsModule,
    RealtimeNotificationsModule,
  ],
  providers: [RealtimeFacade],
  exports: [
    RealtimeFacade,
    RealtimeCoreModule,
    RealtimeManuscriptsModule,
    RealtimeNotificationsModule,
  ],
})
export class RealtimeModule {}
