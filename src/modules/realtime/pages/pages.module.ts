import { Module } from '@nestjs/common';
import { PrismaModule, CacheModule } from '@/core';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { LiveCollaborationPort } from '@/modules/pages/core';

import { RealtimeCoreModule } from '../core/core.module';
import { WsAccessGuard } from '../core/ws-access.guard';
import { PagesGateway } from './pages.gateway';
import { PagesService } from './pages.service';
import { RealtimeAccessService } from './realtime-access.service';
import { RoomStore } from './room.store';
import { YjsService } from './yjs.service';
import { YjsUpdateValidator } from './yjs-update-validator';
import { ChatService } from './chat.service';
import { LiveCollaborationProvider } from './live-collab.provider';
import { AccessRevocationListener } from './access-revocation.listener';

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
    PagesService,
    RealtimeAccessService,
    WsAccessGuard,
    AccessRevocationListener,
    RoomStore,
    YjsUpdateValidator,
    YjsService,
    ChatService,
    LiveCollaborationProvider,
    {
      provide: LiveCollaborationPort,
      useExisting: LiveCollaborationProvider,
    },
  ],
  exports: [
    PagesGateway,
    PagesService,
    RealtimeAccessService,
    WsAccessGuard,
    RoomStore,
    YjsUpdateValidator,
    YjsService,
    ChatService,
    LiveCollaborationPort,
  ],
})
export class RealtimePagesModule {}
export {
  RealtimePagesModule as RealtimeManuscriptsModule,
  RealtimePagesModule as PagesModule,
  RealtimePagesModule as ManuscriptsModule,
};
