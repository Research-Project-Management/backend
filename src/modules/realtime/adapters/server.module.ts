import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule, PrismaModule } from '@/core';
import { ChatCacheService } from '@/modules/project/chat/services/chat-cache.service';
import { ChatService } from '@/modules/project/chat/services/chat.service';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { UserRepository } from '@/modules/identity/user/user.repository';
import {
  DocArchiveRepository,
  DocstoreRepository,
  DocstoreService,
  IDocPersistor,
} from '@/modules/pages/docstore';
import { AccessRepository } from '@/modules/project/access/access.repository';
import { AccessService } from '@/modules/project/access/access.service';
import { CHAT_REALTIME_PORT } from '../ports/chat';
import { WORK_ITEMS_ACCESS_PORT } from '../ports/work-items';
import { ChatInProcessAdapter } from './chat';
import { RealtimeIdentityLookup } from './identity';
import { WorkItemsAccessAdapter } from './work-items';

@Global()
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule],
  providers: [
    UserRepository,
    RealtimeIdentityLookup,
    { provide: IdentityFacade, useExisting: RealtimeIdentityLookup },
    AccessRepository,
    AccessService,
    WorkItemsAccessAdapter,
    { provide: WORK_ITEMS_ACCESS_PORT, useExisting: WorkItemsAccessAdapter },
    ChatCacheService,
    ChatService,
    ChatInProcessAdapter,
    { provide: CHAT_REALTIME_PORT, useExisting: ChatInProcessAdapter },
    DocstoreRepository,
    DocArchiveRepository,
    { provide: IDocPersistor, useExisting: DocArchiveRepository },
    DocstoreService,
  ],
  exports: [
    IdentityFacade,
    AccessService,
    DocstoreService,
    CHAT_REALTIME_PORT,
    WORK_ITEMS_ACCESS_PORT,
  ],
})
export class RealtimeServerAdaptersModule {}
