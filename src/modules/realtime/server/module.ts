import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtimeServerAdaptersModule } from '../adapters/server.module';
import { RealtimeChatChannelModule } from '../channels/chat/module';
import { RealtimePagesModule } from '../channels/pages/module';
import { RealtimeWorkItemsChannelModule } from '../channels/work-items/module';
import { RealtimeCoreModule } from '../core/module';
import { RealtimeInternalAuthGuard } from '../internal/auth';
import { RealtimeControlController } from '../internal/controller';
import { RealtimeFacade } from '../realtime.facade';

@Global()
@Module({
  imports: [
    ConfigModule,
    RealtimeCoreModule,
    RealtimeServerAdaptersModule,
    RealtimePagesModule,
    RealtimeChatChannelModule,
    RealtimeWorkItemsChannelModule,
  ],
  controllers: [RealtimeControlController],
  providers: [RealtimeInternalAuthGuard, RealtimeFacade],
  exports: [
    RealtimeFacade,
    RealtimeCoreModule,
    RealtimeServerAdaptersModule,
    RealtimePagesModule,
    RealtimeChatChannelModule,
    RealtimeWorkItemsChannelModule,
  ],
})
export class RealtimeServerModule {}
