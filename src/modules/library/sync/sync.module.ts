import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule as AppCoreModule } from '../../../core/core.module';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';

import { LIBRARY_OUTBOX_QUEUE } from './core/domain/outbox.constants';
import { OutboxQueueConsumer } from './core/adapters/outbox-queue.consumer';
import { TransactionService } from './core/adapters/transaction.service';
import { ChangeLogRepository } from './core/adapters/changelog.repository';
import { OutboxWorker } from './core/adapters/outbox.worker';
import {
  OutboxDispatcher,
  EventDispatcher,
  EXTERNAL_BROKER_TRANSPORT,
} from './core/adapters/outbox.dispatcher';
import {
  IntegrationEventBusService,
  INTEGRATION_EVENT_BUS,
} from '../shared-kernel/events/integration-event-bus.service';
import { EVENT_PUBLISHER_PORT } from './core/ports/event-publisher.port';
import { UNIT_OF_WORK_PORT } from './core/ports/unit-of-work.port';
import {
  OutboxMetrics,
  SyncMetricsService,
} from './core/adapters/outbox.metrics';
import { LIBRARY_EVENT_TYPES } from './core/domain/outbox.events';
import { SyncController } from './sync.controller';
import { IdempotentConsumerService } from './core/adapters/idempotent-consumer.service';
import { shouldRunWorkerConsumers } from '../../../core/utils/worker-mode.util';

const syncWorkerProviders = shouldRunWorkerConsumers()
  ? [OutboxQueueConsumer]
  : [];

/**
 * Dedicated Sync & Change Data Capture (CDC) Module.
 * Parity with Manuscripts Realtime / Overleaf Delta Sync Architecture.
 *
 * Sole owner of the Outbox pattern stack:
 * - Transactional Outbox Engine (Workers, Queue Consumer, Dispatcher, Metrics)
 * - Monotonic Sequence Versioning & Checkpoints
 * - Delta Changes & Tombstones API (SyncController)
 * - Idempotent Consumer Protection (exactly-once guarantee)
 *
 * Imports SharedKernelModule for ResilienceRegistryService (circuit breakers used
 * by IdempotentConsumerService and OutboxDispatcher).
 */
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
    ChangeLogRepository,
    OutboxWorker,
    OutboxDispatcher,
    {
      provide: EVENT_PUBLISHER_PORT,
      useExisting: OutboxDispatcher,
    },
    OutboxMetrics,
    ...syncWorkerProviders,
    IdempotentConsumerService,
    IntegrationEventBusService,
    {
      provide: INTEGRATION_EVENT_BUS,
      useExisting: IntegrationEventBusService,
    },
  ],
  exports: [
    TransactionService,
    UNIT_OF_WORK_PORT,
    ChangeLogRepository,
    OutboxWorker,
    OutboxDispatcher,
    EventDispatcher,
    EVENT_PUBLISHER_PORT,
    OutboxMetrics,
    SyncMetricsService,
    IdempotentConsumerService,
    IntegrationEventBusService,
    INTEGRATION_EVENT_BUS,
    // Re-export SharedKernelModule so consumers of SyncModule also get
    // ResilienceRegistryService, GrobidClient, etc. transitively
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
