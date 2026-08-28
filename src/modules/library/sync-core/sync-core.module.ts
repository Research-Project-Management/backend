import { Module, OnModuleInit } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { ChangeLogRepository } from './change-log.repository';
import { IdempotencyRepository } from './idempotency.repository';
import { LibraryTransactionService } from './library-transaction.service';
import { OutboxWorker } from './outbox.worker';
import { SyncMetricsService } from './sync.metrics';
import {
  LibraryDomainEventDispatcher,
  LIBRARY_EVENT_TYPES,
} from './library-event-catalog';
import { CoreModule } from '../../../core/core.module';
import { LIBRARY_SYNC_PORT } from '../library-sync.port';
import { LibrarySyncBridgeService } from './library-sync-bridge.service';

@Module({
  imports: [CoreModule],
  controllers: [SyncController],
  providers: [
    ChangeLogRepository,
    IdempotencyRepository,
    LibraryTransactionService,
    OutboxWorker,
    SyncMetricsService,
    LibraryDomainEventDispatcher,
    LibrarySyncBridgeService,
    {
      provide: LIBRARY_SYNC_PORT,
      useExisting: LibrarySyncBridgeService,
    },
  ],
  exports: [
    LIBRARY_SYNC_PORT,
    LibrarySyncBridgeService,
    LibraryTransactionService,
    ChangeLogRepository,
    IdempotencyRepository,
  ],
})
export class SyncCoreContextModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly dispatcher: LibraryDomainEventDispatcher,
  ) {}

  onModuleInit() {
    for (const evtType of Object.values(LIBRARY_EVENT_TYPES)) {
      if (!this.outboxWorker.hasHandler(evtType)) {
        this.outboxWorker.registerHandler(evtType, this.dispatcher);
      }
    }
  }
}
