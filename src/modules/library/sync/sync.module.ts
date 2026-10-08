import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule as AppCoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';

import { LIBRARY_OUTBOX_QUEUE } from './types/outbox.constants';
import { OutboxQueueConsumer } from './services/outbox-queue.consumer';
import { TransactionService as SharedTransactionService } from '../shared-kernel/ports/unit-of-work.port';
import { TransactionService } from './services/transaction.service';
import { ChangeLogRepository } from './repositories/changelog.repository';
import { OutboxWorker } from './services/outbox.worker';
import {
  OutboxDispatcher,
  EXTERNAL_BROKER_TRANSPORT,
} from './services/outbox.dispatcher';
import { IntegrationEventBusService } from './services/integration-event-bus.service';
import { INTEGRATION_EVENT_BUS } from '../shared-kernel/events/integration-events';
import { EVENT_PUBLISHER_PORT } from './types/event-publisher.types';
import { UNIT_OF_WORK_PORT } from './types/unit-of-work.types';
import {
  OUTBOX_REGISTRY_PORT,
  IDEMPOTENT_CONSUMER_PORT,
} from '../shared-kernel';
import { OutboxMetrics } from './services/outbox.metrics';
import { LIBRARY_EVENT_TYPES } from './types/outbox.events';
import { SyncController } from './controllers/sync.controller';
import { IdempotentConsumerService } from './services/idempotent-consumer.service';
import { shouldRunWorkerConsumers } from '../../../core/utils/worker-mode.util';

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
 * - utils/
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    SharedKernelModule,
    BullModule.registerQueue({
      name: LIBRARY_OUTBOX_QUEUE,
    }),
  ],
  controllers: [SyncController],
  providers: [
    TransactionService,
    {
      provide: UNIT_OF_WORK_PORT,
      useExisting: TransactionService,
    },
    {
      provide: SharedTransactionService,
      useExisting: TransactionService,
    },
    ChangeLogRepository,
    OutboxWorker,
    {
      provide: OUTBOX_REGISTRY_PORT,
      useExisting: OutboxWorker,
    },
    OutboxDispatcher,
    {
      provide: EVENT_PUBLISHER_PORT,
      useExisting: OutboxDispatcher,
    },
    OutboxMetrics,
    ...syncWorkerProviders,
    IdempotentConsumerService,
    {
      provide: IDEMPOTENT_CONSUMER_PORT,
      useExisting: IdempotentConsumerService,
    },
    IntegrationEventBusService,
    {
      provide: INTEGRATION_EVENT_BUS,
      useExisting: IntegrationEventBusService,
    },
  ],
  exports: [
    TransactionService,
    SharedTransactionService,
    UNIT_OF_WORK_PORT,
    ChangeLogRepository,
    OutboxWorker,
    OUTBOX_REGISTRY_PORT,
    OutboxDispatcher,
    EVENT_PUBLISHER_PORT,
    OutboxMetrics,
    IdempotentConsumerService,
    IDEMPOTENT_CONSUMER_PORT,
    IntegrationEventBusService,
    INTEGRATION_EVENT_BUS,
    SharedKernelModule,
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

export * from './dto/sync-query.dto';
export { SyncController };
