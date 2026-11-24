import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisModule, PrismaModule } from '@/core';
import { ChatCacheService } from '@/modules/chat/services/chat-cache.service';
import { ChatService } from '@/modules/chat/services/chat.service';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { UserRepository } from '@/modules/identity/user/user.repository';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  DocHasherAdapter,
  IDocHasher,
  IDocPersistor,
  IDocRepository,
} from '@/modules/pages/docstore/domain';
import {
  DocArchiveRepository,
  StoragePortDocArchiveAdapter,
} from '@/modules/pages/docstore/repositories/archive.repository';
import { DocstoreRepository } from '@/modules/pages/docstore/repositories/docstore.repository';
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
    { provide: IDocRepository, useExisting: DocstoreRepository },
    DocHasherAdapter,
    { provide: IDocHasher, useExisting: DocHasherAdapter },
    DocArchiveRepository,
    StoragePortDocArchiveAdapter,
    { provide: IDocPersistor, useExisting: StoragePortDocArchiveAdapter },
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
