import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import {
  DomainEventEnvelope,
  OutboxDispatchHandler,
} from '@/modules/library/core';
import { SubsystemUnavailableException } from '@/modules/library/core/errors/domain.exception';
import { OutboxMetrics } from './outbox-metrics.service';

@Injectable()
export class OutboxDispatcher implements OutboxDispatchHandler {
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: OutboxMetrics,
  ) {}

  async publish<T = unknown>(envelope: DomainEventEnvelope<T>): Promise<void> {
    this.logger.debug(
      `[DomainEventHandler] Dispatched ${envelope.eventType} for aggregate ${envelope.aggregateId} (scope: ${envelope.scopeId || envelope.projectId || envelope.userId})`,
    );
    if (this.eventEmitter)
      await this.eventEmitter.emitAsync(envelope.eventType, envelope);
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
    return this.publish({
      eventId: event.id,
      userId: event.userId,
      projectId: event.projectId ?? undefined,
      scopeId: event.projectId || event.userId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt,
      schemaVersion: 1,
    });
  }
}
