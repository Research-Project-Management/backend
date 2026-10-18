import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule as AppCoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';

import { LIBRARY_OUTBOX_QUEUE } from './types/outbox.constants';
import { OutboxQueueConsumer } from './services/outbox-queue.consumer';
import { TransactionService as SharedTransactionService } from '@/modules/library/core/ports/unit-of-work.port';
import { TransactionService } from './services/transaction.service';
import { ChangeLogRepository } from './repositories/changelog.repository';
import { ChangeLogService } from './services/changelog.service';
import { OutboxWorker } from './services/outbox.worker';
import { OutboxDispatcher } from './services/outbox.dispatcher';
import { IntegrationEventBusService } from './services/integration-event-bus.service';
import {
  OUTBOX_REGISTRY_PORT,
  LIBRARY_EVENT_TYPES,
} from '@/modules/library/core';
import { OutboxMetrics } from './services/outbox.metrics';
import { SyncController } from './controllers/sync.controller';
import { IdempotentConsumerService } from './services/idempotent-consumer.service';
import { shouldRunWorkerConsumers } from '@/core';

const syncWorkerProviders = shouldRunWorkerConsumers()
  ? [OutboxQueueConsumer]
  : [];

/**
 * Dedicated Sync & Change Data Capture (CDC) Module.
 * Parity with Manuscripts Realtime / Overleaf Delta Sync Architecture.
 *
 * Flat, symmetrical architecture:
 * - controllers/
 * - services/
 * - repositories/
 * - dto/
 * - types/
 * - domain/
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    LibraryCoreModule,
    BullModule.registerQueue({
      name: LIBRARY_OUTBOX_QUEUE,
    }),
  ],
  controllers: [SyncController],
  providers: [
    TransactionService,
    {
      provide: SharedTransactionService,
      useExisting: TransactionService,
    },
    ChangeLogRepository,
    ChangeLogService,
    OutboxWorker,
    {
      provide: OUTBOX_REGISTRY_PORT,
      useExisting: OutboxWorker,
    },
    OutboxDispatcher,
    OutboxMetrics,
    ...syncWorkerProviders,
    IdempotentConsumerService,
    IntegrationEventBusService,
  ],
  exports: [
    TransactionService,
    SharedTransactionService,
    ChangeLogRepository,
    ChangeLogService,
    OutboxWorker,
    OUTBOX_REGISTRY_PORT,
    OutboxDispatcher,
    OutboxMetrics,
    IdempotentConsumerService,
    IntegrationEventBusService,
    LibraryCoreModule,
  ],
})
export class SyncModule implements OnModuleInit {
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
