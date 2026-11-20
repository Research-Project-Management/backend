import { Module } from '@nestjs/common';
import { PrismaModule, CacheModule } from '@/core';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { LiveCollaborationPort } from '@/modules/pages/core';

import { RealtimeCoreModule } from '../core/core.module';
import { WsAccessGuard } from './access/ws-access.guard';
import { RealtimeAccessService } from './access/realtime-access.service';
import { AccessRevocationListener } from './access/access-revocation.listener';
import { RoomPresenceStore } from './presence/room-presence.store';
import { YjsUpdateValidator } from './yjs/yjs-update.validator';
import { YjsService } from './yjs/yjs.service';
import { PagesChatService } from './chat/pages-chat.service';
import { LiveCollaborationAdapter } from './bridges/live-collab.adapter';
import { PagesDomainEventsListener } from './bridges/pages-domain-events.listener';
import { PagesSessionService } from './pages-session.service';
import { PagesGateway } from './pages.gateway';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    AccessModule,
    DocstoreModule,
    RealtimeCoreModule,
  ],
  providers: [
    PagesGateway,
    PagesSessionService,
    RealtimeAccessService,
    WsAccessGuard,
    AccessRevocationListener,
    RoomPresenceStore,
    YjsUpdateValidator,
    YjsService,
    PagesChatService,
    LiveCollaborationAdapter,
    PagesDomainEventsListener,
    {
      provide: LiveCollaborationPort,
      useExisting: LiveCollaborationAdapter,
    },
  ],
  exports: [
    PagesGateway,
    PagesSessionService,
    RealtimeAccessService,
    WsAccessGuard,
    RoomPresenceStore,
    YjsUpdateValidator,
    YjsService,
    PagesChatService,
    LiveCollaborationPort,
  ],
})
export class RealtimePagesModule {}
