import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule, CacheModule } from '@/core';
import { AccessModule } from '@/modules/project/access';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { LiveCollaborationPort } from '@/modules/manuscripts/core';

import { CoreModule } from '../core/core.module';
import { WsAccessGuard } from '../core/ws-access.guard';
import { ManuscriptsGateway } from './manuscripts.gateway';
import { ManuscriptsService } from './manuscripts.service';
import { RealtimeAccessService } from './realtime-access.service';
import { RoomStore } from './room.store';
import { YjsService } from './yjs.service';
import { ChatService } from './chat.service';
import { LiveCollaborationProvider } from './live-collab.provider';
import { AccessRevocationListener } from './access-revocation.listener';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    PrismaModule,
    CacheModule,
    AccessModule,
    DocstoreModule,
    CoreModule,
  ],
  providers: [
    ManuscriptsGateway,
    ManuscriptsService,
    RealtimeAccessService,
    WsAccessGuard,
    AccessRevocationListener,
    RoomStore,
    YjsService,
    ChatService,
    LiveCollaborationProvider,
    {
      provide: LiveCollaborationPort,
      useExisting: LiveCollaborationProvider,
    },
  ],
  exports: [
    ManuscriptsGateway,
    ManuscriptsService,
    RealtimeAccessService,
    WsAccessGuard,
    RoomStore,
    YjsService,
    ChatService,
    LiveCollaborationPort,
  ],
})
export class ManuscriptsModule {}
