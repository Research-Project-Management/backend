import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from './outbox.types';
import { OutboxMetrics } from './outbox.metrics';
import { LIBRARY_EVENT_CATALOG } from './outbox.events';

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Emits typed domain events via EventEmitter2 and increments telemetry metrics.
 */
@Injectable()
export class OutboxDispatcher implements OutboxDispatchHandler {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: OutboxMetrics,
  ) {}

  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new Error(
          `Handler execution aborted for event ${event.id} (lease lost)`,
        ),
      );
    }

    const entry = LIBRARY_EVENT_CATALOG[event.eventType];
    this.logger.debug(
      `[DomainEventDispatcher] Dispatched ${event.eventType} for aggregate ${event.aggregateId} (workspace: ${event.workspaceId}) - ${entry?.expectedSideEffect || 'internal'}`,
    );

    if (this.eventEmitter) {
      this.eventEmitter.emit(event.eventType, {
        eventId: event.id,
        workspaceId: event.workspaceId,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
      });
    }

    this.metricsService?.incrementCounter('outbox_dispatched_total');
    return Promise.resolve();
  }
}

export const EventDispatcher = OutboxDispatcher;
export type EventDispatcher = OutboxDispatcher;
