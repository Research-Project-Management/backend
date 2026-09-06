import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from './outbox.types';
import {
  IEventPublisherPort,
  DomainEventEnvelope,
} from './ports/event-publisher.port';
import { OutboxMetrics } from './outbox.metrics';
import { LIBRARY_EVENT_CATALOG } from './outbox.events';

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Implements IEventPublisherPort: Emits typed domain events via EventEmitter2 (in-process)
 * or forwards to external brokers in a distributed microservices environment.
 */
@Injectable()
export class OutboxDispatcher
  implements OutboxDispatchHandler, IEventPublisherPort
{
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: OutboxMetrics,
  ) {}

  async publish<T = any>(envelope: DomainEventEnvelope<T>): Promise<void> {
    const entry = LIBRARY_EVENT_CATALOG[envelope.eventType];
    this.logger.debug(
      `[DomainEventDispatcher] Dispatched ${envelope.eventType} for aggregate ${envelope.aggregateId} (workspace: ${envelope.workspaceId}) - ${entry?.expectedSideEffect || 'internal'}`,
    );

    if (this.eventEmitter) {
      this.eventEmitter.emit(envelope.eventType, envelope);
    }

    this.metricsService?.incrementCounter('outbox_dispatched_total');
  }

  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new Error(
          `Handler execution aborted for event ${event.id} (lease lost)`,
        ),
      );
    }

    const envelope: DomainEventEnvelope = {
      eventId: event.id,
      workspaceId: event.workspaceId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt,
      schemaVersion: 1,
    };

    return this.publish(envelope);
  }
}

export const EventDispatcher = OutboxDispatcher;
export type EventDispatcher = OutboxDispatcher;

