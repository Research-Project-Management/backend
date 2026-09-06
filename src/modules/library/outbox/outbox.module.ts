import { Module, OnModuleInit } from '@nestjs/common';
import { CoreModule } from '../../../core/core.module';
import { TransactionService } from './transaction.service';
import { OutboxWorker } from './outbox.worker';
import { OutboxDispatcher, EventDispatcher } from './outbox.dispatcher';
import { EVENT_PUBLISHER_PORT } from './ports/event-publisher.port';
import { OutboxMetrics, SyncMetricsService } from './outbox.metrics';
import { ChangeLogRepository } from './repositories/changelog.repository';
import { LIBRARY_EVENT_TYPES } from './outbox.events';

@Module({
  imports: [CoreModule],
  providers: [
    TransactionService,
    ChangeLogRepository,
    OutboxWorker,
    OutboxDispatcher,
    {
      provide: EVENT_PUBLISHER_PORT,
      useExisting: OutboxDispatcher,
    },
    OutboxMetrics,
  ],
  exports: [
    TransactionService,
    OutboxWorker,
    OutboxDispatcher,
    EventDispatcher,
    EVENT_PUBLISHER_PORT,
    OutboxMetrics,
    SyncMetricsService,
  ],
})
export class OutboxModule implements OnModuleInit {
  constructor(
    private readonly outboxWorker: OutboxWorker,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  onModuleInit() {
    this.outboxWorker.registerDefaultHandler(this.dispatcher);
    for (const evtType of Object.values(LIBRARY_EVENT_TYPES)) {
      if (!this.outboxWorker.hasHandler(evtType)) {
        this.outboxWorker.registerHandler(evtType, this.dispatcher);
      }
    }
  }
}
