import { Module, OnModuleInit } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { ChangeLogRepository } from './repositories/change-log.repository';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { TransactionService } from './services/transaction.service';
import { OutboxWorker } from './workers/outbox.worker';
import { SyncMetricsService } from './metrics/sync.metrics';
import { EventDispatcher, SYNC_EVENT_TYPES } from './events/library.events';
import { CoreModule } from '../../../core/core.module';
import { SYNC_PORT } from './ports/sync.port';
import { SyncService } from './sync.service';

@Module({
  imports: [CoreModule],
  controllers: [SyncController],
  providers: [
    ChangeLogRepository,
    IdempotencyRepository,
    TransactionService,
    OutboxWorker,
    SyncMetricsService,
    EventDispatcher,
    SyncService,
    {
      provide: SYNC_PORT,
      useExisting: SyncService,
    },
  ],
  exports: [SYNC_PORT, SyncService, TransactionService, IdempotencyRepository],
})
export class SyncModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly dispatcher: EventDispatcher,
  ) {}

  onModuleInit() {
    for (const evtType of Object.values(SYNC_EVENT_TYPES)) {
      if (!this.outboxWorker.hasHandler(evtType)) {
        this.outboxWorker.registerHandler(evtType, this.dispatcher);
      }
    }
  }
}
