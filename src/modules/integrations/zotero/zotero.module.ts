import { Module, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../core/database/prisma.module';
import { LibraryModule } from '../../library/library.module';
import { LIBRARY_SYNC_PORT, ILibrarySyncPort } from '../../library/sync/library-sync.port';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import { ZoteroPullWorker } from './zotero-pull.worker';
import { ZoteroReconcileWorker } from './zotero-reconcile.worker';
import { ZoteroConflictService } from './zotero-conflict.service';
import { ZoteroSyncPolicy } from './zotero-sync.policy';
import { ZoteroPushWorker } from './zotero-push.worker';
import { ZoteroFileConnector } from './zotero-file.connector';
import { ZoteroWebSocketListener } from './zotero-websocket.listener';
import { ZoteroStreamOutboxHandler } from './zotero-stream.handler';
import { ZoteroController } from './zotero.controller';

@Module({
  imports: [PrismaModule, ConfigModule, LibraryModule],
  controllers: [ZoteroController],
  providers: [
    ZoteroConnectionService,
    ZoteroConnector,
    ZoteroFileConnector,
    ZoteroMapper,
    ZoteroPullWorker,
    ZoteroReconcileWorker,
    ZoteroConflictService,
    ZoteroSyncPolicy,
    ZoteroPushWorker,
    ZoteroWebSocketListener,
    ZoteroStreamOutboxHandler,
  ],
  exports: [
    ZoteroConnectionService,
    ZoteroConnector,
    ZoteroFileConnector,
    ZoteroMapper,
    ZoteroPullWorker,
    ZoteroReconcileWorker,
    ZoteroConflictService,
    ZoteroSyncPolicy,
    ZoteroPushWorker,
    ZoteroWebSocketListener,
  ],
})
export class ZoteroModule implements OnModuleInit {
  constructor(
    @Inject(LIBRARY_SYNC_PORT)
    private readonly libraryBridge: ILibrarySyncPort,
    private readonly streamHandler: ZoteroStreamOutboxHandler,
  ) {}

  onModuleInit() {
    this.libraryBridge.registerIntegrationEventHandler(
      'library.zotero.stream_event_received',
      (evt) => this.streamHandler.handle(evt),
    );
  }
}
