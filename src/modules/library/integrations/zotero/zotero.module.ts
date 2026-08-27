import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../../core/database/prisma.module';
import { SyncCoreContextModule } from '../../sync-core/sync-core.module';
import { OutboxWorker } from '../../sync-core/outbox.worker';
import { LibraryFeatureFlagsService } from '../../common/library-feature-flags';
import { ZoteroConnectionService } from './zotero-connection.service';
import { ZoteroConnector } from './zotero.connector';
import { ZoteroMapper } from './zotero.mapper';
import { ZoteroPullWorker } from './zotero-pull.worker';
import { ZoteroReconcileWorker } from './zotero-reconcile.worker';
import { ZoteroConflictService } from './zotero-conflict.service';
import { ZoteroSyncPolicy } from './zotero-sync-policy';
import { ZoteroPushWorker } from './zotero-push.worker';
import { ZoteroFileConnector } from './zotero-file.connector';
import { ZoteroWebSocketListener } from './zotero-websocket.listener';
import { ZoteroStreamOutboxHandler } from './zotero-stream.handler';
import { ZoteroController } from './zotero.controller';

@Module({
  imports: [PrismaModule, ConfigModule, SyncCoreContextModule],
  controllers: [ZoteroController],
  providers: [
    LibraryFeatureFlagsService,
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
    LibraryFeatureFlagsService,
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
    private readonly outboxWorker: OutboxWorker,
    private readonly streamHandler: ZoteroStreamOutboxHandler,
  ) {}

  onModuleInit() {
    this.outboxWorker.registerHandler(
      'library.zotero.stream_event_received',
      this.streamHandler,
    );
  }
}
