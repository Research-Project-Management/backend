import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TransactionService } from './transaction.service';
import {
  BaseIntegrationEvent,
  IIntegrationEventBus,
  INTEGRATION_EVENT_BUS,
} from '../../shared-kernel/events/integration-events';
import { TransactionHelpers } from '../../shared-kernel';

export { INTEGRATION_EVENT_BUS, IIntegrationEventBus };

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
    const payloadObj =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as { itemId?: string; runId?: string })
        : null;
    const aggregateId =
      payloadObj?.itemId || payloadObj?.runId || event.eventId;

    this.logger.debug(
      `[EventBus] Publishing integration event "${event.topic}" from [${event.sourceContext}] (aggregate: ${aggregateId})`,
    );

    // 1. Transactionally persist to Outbox for durable relay
    await this.libraryTx.executeInTransaction(
      async (_tx, helpers: TransactionHelpers) => {
        await helpers.publishOutbox(
          {
            userId: event.scope.userId,
            projectId: event.scope.projectId ?? null,
          },
          aggregateId,
          event.topic,
          event,
        );
      },
    );

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
