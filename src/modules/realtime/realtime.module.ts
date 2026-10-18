import { Module, Global } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { ManuscriptsModule } from './manuscripts/manuscripts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { RealtimeFacade } from './realtime.facade';

@Global()
@Module({
  imports: [CoreModule, ManuscriptsModule, NotificationsModule],
  providers: [RealtimeFacade],
  exports: [
    RealtimeFacade,
    CoreModule,
    ManuscriptsModule,
    NotificationsModule,
  ],
})
export class RealtimeModule {}
