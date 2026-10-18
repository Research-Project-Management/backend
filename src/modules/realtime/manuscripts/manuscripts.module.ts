import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule, CacheModule } from '@/core';
import { DocumentUpdaterModule } from '@/modules/manuscripts/document-updater/document-updater.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { LiveCollaborationPort } from '@/modules/manuscripts/docstore/domain';

import { CoreModule } from '../core/core.module';
import { ManuscriptsGateway } from './manuscripts.gateway';
import { ManuscriptsService } from './manuscripts.service';
import { RoomStore } from './room.store';
import { YjsService } from './yjs.service';
import { ChatService } from './chat.service';
import { LiveCollaborationProvider } from './live-collab.provider';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    PrismaModule,
    CacheModule,
    DocumentUpdaterModule,
    DocstoreModule,
    CoreModule,
  ],
  providers: [
    ManuscriptsGateway,
    ManuscriptsService,
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
    RoomStore,
    YjsService,
    ChatService,
    LiveCollaborationPort,
  ],
})
export class ManuscriptsModule {}
