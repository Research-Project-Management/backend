import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from './outbox.worker';
import { DomainEventEnvelope } from '@/modules/library/core';
import { OutboxMetrics } from './outbox.metrics';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Emits typed domain events via EventEmitter2 (in-process).
 */
@Injectable()
export class OutboxDispatcher implements OutboxDispatchHandler {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: OutboxMetrics,
  ) {}

  async publish<T = unknown>(envelope: DomainEventEnvelope<T>): Promise<void> {
    this.logger.debug(
      `[DomainEventDispatcher] Dispatched ${envelope.eventType} for aggregate ${envelope.aggregateId} (scope: ${envelope.scopeId || envelope.projectId || envelope.userId})`,
    );

    if (this.eventEmitter) {
      await this.eventEmitter.emitAsync(envelope.eventType, envelope);
    }

    this.metricsService?.incrementCounter('outbox_dispatched_total');
  }

  handle(event: OutboxEvent, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new SubsystemUnavailableException(
          `Handler execution aborted for event ${event.id} (lease lost)`,
          { eventId: event.id },
        ),
      );
    }

    const envelope: DomainEventEnvelope = {
      eventId: event.id,
      userId: event.userId,
      projectId: event.projectId ?? undefined,
      scopeId: event.projectId || event.userId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt,
      schemaVersion: 1,
    };

    return this.publish(envelope);
  }
}
