import { Module, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../core/database/prisma.module';
import { LibraryModule } from '../../library/library.module';
import { SYNC_PORT, SyncPort } from '../../library/sync/ports/sync.port';
import { ZoteroRepository } from './zotero.repository';
import { ZoteroService } from './zotero.service';
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
import { ZOTERO_EVENT_TYPES } from './events/zotero.events';

@Module({
  imports: [PrismaModule, ConfigModule, LibraryModule],
  controllers: [ZoteroController],
  providers: [
    ZoteroRepository,
    ZoteroService,
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
  exports: [ZoteroService],
})
export class ZoteroModule implements OnModuleInit {
  constructor(
    @Inject(SYNC_PORT)
    private readonly libraryBridge: SyncPort,
    private readonly streamHandler: ZoteroStreamOutboxHandler,
  ) {}

  onModuleInit() {
    this.libraryBridge.registerIntegrationEventHandler(
      ZOTERO_EVENT_TYPES.STREAM_RECEIVED,
      (evt) => this.streamHandler.handle(evt),
    );
    // Backward-compatible registration for legacy topic string
    this.libraryBridge.registerIntegrationEventHandler(
      'library.zotero.stream_event_received',
      (evt) => this.streamHandler.handle(evt),
    );
  }
}
