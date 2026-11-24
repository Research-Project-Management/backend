import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule, RedisModule } from '@/core';
import { LiveCollaborationPort } from '@/modules/pages/core/ports/live-collaboration.port';

import { RealtimeCoreModule } from '../../core/module';
import { PagesRealtimeConfigService } from './config';
import { PagesGateway } from './gateway';
import { WsAccessGuard } from './guard';
import { YjsUpdateValidator } from './yjs/sync';
import { RoomPresenceStore } from './presence';
import { RealtimeAccessService } from './access';
import { YjsService } from './yjs/engine';
import { PagesSessionService } from './session';
import {
  AccessRevocationListener,
  LiveCollaborationAdapter,
  PagesDomainEventsListener,
} from './bridge';

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, RealtimeCoreModule],
  providers: [
    PagesRealtimeConfigService,
    PagesGateway,
    PagesSessionService,
    RealtimeAccessService,
    WsAccessGuard,
    AccessRevocationListener,
    RoomPresenceStore,
    YjsUpdateValidator,
    YjsService,
    LiveCollaborationAdapter,
    PagesDomainEventsListener,
    {
      provide: LiveCollaborationPort,
      useExisting: LiveCollaborationAdapter,
    },
  ],
  exports: [
    PagesRealtimeConfigService,
    PagesGateway,
    PagesSessionService,
    RealtimeAccessService,
    WsAccessGuard,
    RoomPresenceStore,
    YjsUpdateValidator,
    YjsService,
    LiveCollaborationPort,
  ],
})
export class RealtimePagesModule {}
