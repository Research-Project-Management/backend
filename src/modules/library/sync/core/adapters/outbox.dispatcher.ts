import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from '../domain/outbox.types';
import {
  IEventPublisherPort,
  DomainEventEnvelope,
} from '../ports/event-publisher.port';
import { OutboxMetrics } from './outbox.metrics';
import { LIBRARY_EVENT_REGISTRY } from '../domain/outbox.events';

export const EXTERNAL_BROKER_TRANSPORT = Symbol('EXTERNAL_BROKER_TRANSPORT');

export interface IExternalBrokerTransport {
  publish<T = any>(envelope: DomainEventEnvelope<T>): Promise<void>;
}

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Implements IEventPublisherPort: Emits typed domain events via EventEmitter2 (in-process)
 * or forwards to external brokers (Kafka/NATS/RabbitMQ) in a distributed microservices environment.
 */
@Injectable()
export class OutboxDispatcher
  implements OutboxDispatchHandler, IEventPublisherPort
{
  private readonly logger = new Logger(OutboxDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: OutboxMetrics,
    @Optional()
    @Inject(EXTERNAL_BROKER_TRANSPORT)
    private readonly externalBroker?: IExternalBrokerTransport,
  ) {}

  async publish<T = any>(envelope: DomainEventEnvelope<T>): Promise<void> {
    const entry = LIBRARY_EVENT_REGISTRY[envelope.eventType];
    this.logger.debug(
      `[DomainEventDispatcher] Dispatched ${envelope.eventType} for aggregate ${envelope.aggregateId} (scope: ${envelope.scopeId || envelope.projectId || envelope.userId}) - ${entry?.expectedSideEffect || 'internal'}`,
    );

    // 1. In-process dispatch (EventEmitter2)
    if (this.eventEmitter) {
      await this.eventEmitter.emitAsync(envelope.eventType, envelope);
    }

    // 2. Distributed microservice broker dispatch (Kafka / NATS / Redis Streams)
    if (this.externalBroker) {
      try {
        await this.externalBroker.publish(envelope);
      } catch (err: any) {
        this.logger.error(
          `[DomainEventDispatcher] External broker publish failed for ${envelope.eventType}: ${err?.message || err}`,
        );
      }
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

export const EventDispatcher = OutboxDispatcher;
export type EventDispatcher = OutboxDispatcher;
