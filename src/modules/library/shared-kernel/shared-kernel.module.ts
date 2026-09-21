import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { CoreModule as AppCoreModule } from '../../../core/core.module';
import { LIBRARY_OUTBOX_QUEUE } from './outbox/outbox.constants';
import { OutboxQueueConsumer } from './outbox/outbox-queue.consumer';

// ── 1. Events ─────────────────────────────────────────────────────────────
import {
  IntegrationEventBusService,
  INTEGRATION_EVENT_BUS,
} from './events/integration-event-bus.service';

// ── 2. Infrastructure Sidecars ────────────────────────────────────────────
import { GrobidClient } from './infra/grobid/grobid.client';
import { ZoteroTranslatorClient } from './infra/zotero/zotero-translator.client';

// ── 3. Core Cross-Cutting ─────────────────────────────────────────────────
import { SsrfGuardService } from './core/services/ssrf-guard.service';
import { CorrelationIdMiddleware } from './core/middlewares/correlation-id.middleware';
import { IdempotencyMiddleware } from './core/middlewares/idempotency.middleware';
import { DomainExceptionFilter } from './core/filters/domain-exception.filter';

import { TransactionService } from './outbox/transaction.service';
import { ChangeLogRepository } from './outbox/repositories/changelog.repository';
import { OutboxWorker } from './outbox/outbox.worker';
import { OutboxDispatcher, EventDispatcher } from './outbox/outbox.dispatcher';
import { EVENT_PUBLISHER_PORT } from './outbox/ports/event-publisher.port';
import { UNIT_OF_WORK_PORT } from './outbox/ports/unit-of-work.port';
import { OutboxMetrics, SyncMetricsService } from './outbox/outbox.metrics';
import { LIBRARY_EVENT_TYPES } from './outbox/outbox.events';

/**
 * Unified Shared Kernel Module.
 *
 * Consolidates all cross-cutting infrastructure and messaging into a single module:
 * - Integration Event Bus (In-memory asynchronous cross-BC event router)
 * - Infrastructure Clients (GROBID Extraction Server, Zotero Translation Server)
 * - Outbox Engine (Transactional worker, dispatcher, changelog, metrics)
 * - Core Utilities (SSRF guard, correlation ID, idempotency, domain exception filters)
 */
@Module({
  imports: [
    ConfigModule,
    AppCoreModule,
    BullModule.registerQueue({
      name: LIBRARY_OUTBOX_QUEUE,
    }),
  ],
  providers: [
    // Integration Events
    IntegrationEventBusService,
    {
      provide: INTEGRATION_EVENT_BUS,
      useExisting: IntegrationEventBusService,
    },

    // External Sidecars
    GrobidClient,
    ZoteroTranslatorClient,

    // Core Utilities
    SsrfGuardService,
    CorrelationIdMiddleware,
    IdempotencyMiddleware,
    DomainExceptionFilter,

    // Outbox & Transaction
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
    OutboxQueueConsumer,
  ],
  exports: [
    // Integration Events
    IntegrationEventBusService,
    INTEGRATION_EVENT_BUS,

    // External Sidecars
    GrobidClient,
    ZoteroTranslatorClient,

    // Core Utilities
    SsrfGuardService,
    CorrelationIdMiddleware,
    IdempotencyMiddleware,
    DomainExceptionFilter,

    // Outbox & Transaction
    TransactionService,
    UNIT_OF_WORK_PORT,
    ChangeLogRepository,
    OutboxWorker,
    OutboxDispatcher,
    EventDispatcher,
    EVENT_PUBLISHER_PORT,
    OutboxMetrics,
    SyncMetricsService,
    OutboxQueueConsumer,
  ],
})
export class SharedKernelModule implements OnModuleInit {
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
