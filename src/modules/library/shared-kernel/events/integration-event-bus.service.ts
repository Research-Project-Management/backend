import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TransactionService } from '../outbox/transaction.service';
import { BaseIntegrationEvent } from './integration-events';

export const INTEGRATION_EVENT_BUS = Symbol('INTEGRATION_EVENT_BUS');

export interface IIntegrationEventBus {
  publish<T>(event: BaseIntegrationEvent<T>): Promise<void>;
  publishBatch<T>(events: BaseIntegrationEvent<T>[]): Promise<void>;
}

/**
 * IntegrationEventBusService coordinates asynchronous cross-context messaging.
 * - Writes to Transactional Outbox for guaranteed at-least-once delivery & microservices export.
 * - Emits on EventEmitter2 for fast in-process asynchronous subscriber dispatch.
 */
@Injectable()
export class IntegrationEventBusService implements IIntegrationEventBus {
  private readonly logger = new Logger(IntegrationEventBusService.name);

  constructor(
    private readonly libraryTx: TransactionService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  async publish<T>(event: BaseIntegrationEvent<T>): Promise<void> {
    this.logger.debug(
      `[EventBus] Publishing integration event "${event.topic}" from [${event.sourceContext}] (aggregate: ${(event.payload as any)?.itemId || (event.payload as any)?.runId || event.eventId})`,
    );

    // 1. Transactionally persist to Outbox for durable relay
    await this.libraryTx.executeInTransaction(async (tx, helpers) => {
      await helpers.publishOutbox(
        {
          userId: event.scope.userId,
          projectId: event.scope.projectId ?? null,
        },
        (event.payload as any)?.itemId ||
          (event.payload as any)?.runId ||
          event.eventId,
        event.topic,
        event,
      );
    });

    // 2. Emit in-memory for instant reactive handlers
    if (this.eventEmitter) {
      this.eventEmitter.emit(event.topic, event);
    }
  }

  async publishBatch<T>(events: BaseIntegrationEvent<T>[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}
