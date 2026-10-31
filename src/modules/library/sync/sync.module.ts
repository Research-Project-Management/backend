import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule as AppCoreModule } from '@/core';
import { LibraryCoreModule } from '@/modules/library/core/core.module';

import { LIBRARY_OUTBOX_QUEUE } from './domain/outbox.domain';
import { TransactionService } from './services/transaction.service';
import { ChangeLogRepository } from './repositories/changelog.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import {
  OutboxWorker,
  OutboxDispatcher,
  OutboxMetrics,
  OutboxQueueConsumer,
} from './services/outbox.worker';
import {
  OUTBOX_REGISTRY_PORT,
  LIBRARY_EVENT_TYPES,
  UNIT_OF_WORK,
  IDEMPOTENT_CONSUMER,
} from '@/modules/library/core';
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
      provide: UNIT_OF_WORK,
      useExisting: TransactionService,
    },
    ChangeLogRepository,
    OutboxRepository,
    OutboxWorker,
    {
      provide: OUTBOX_REGISTRY_PORT,
      useExisting: OutboxWorker,
    },
    OutboxDispatcher,
    OutboxMetrics,
    ...syncWorkerProviders,
    IdempotentConsumerService,
    {
      provide: IDEMPOTENT_CONSUMER,
      useExisting: IdempotentConsumerService,
    },
  ],
  exports: [
    TransactionService,
    ChangeLogRepository,
    OutboxRepository,
    UNIT_OF_WORK,
    OUTBOX_REGISTRY_PORT,
    OutboxDispatcher,
    IdempotentConsumerService,
    IDEMPOTENT_CONSUMER,
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
