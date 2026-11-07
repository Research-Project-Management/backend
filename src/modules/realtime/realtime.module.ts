import { Module, Global } from '@nestjs/common';
import { RealtimeCoreModule } from './core/core.module';
import { RealtimePagesModule } from './pages/pages.module';
import { RealtimeNotificationsModule } from './notifications/notifications.module';
import { RealtimeFacade } from './realtime.facade';

@Global()
@Module({
  imports: [
    RealtimeCoreModule,
    RealtimePagesModule,
    RealtimeNotificationsModule,
  ],
  providers: [RealtimeFacade],
  exports: [
    RealtimeFacade,
    RealtimeCoreModule,
    RealtimePagesModule,
    RealtimeNotificationsModule,
  ],
})
export class RealtimeModule {}
