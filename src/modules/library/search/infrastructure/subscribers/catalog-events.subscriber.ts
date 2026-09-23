import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OutboxWorker } from '../../../shared-kernel/outbox/outbox.worker';
import { OutboxEvent } from '@prisma/client';
import {
  INTEGRATION_EVENT_TOPICS,
  BaseIntegrationEvent,
  ItemCreatedIntegrationPayload,
  ItemDeletedIntegrationPayload,
} from '../../../shared-kernel/events/integration-events';
import { SearchService } from '../../application/services/search.service';

/**
 * CatalogEventsSubscriber in Discovery Bounded Context.
 * Listens to Catalog integration events and automatically updates search indexes.
 * Completely eliminates direct synchronous calls from Catalog into SearchModule!
 */
@Injectable()
export class CatalogEventsSubscriber implements OnModuleInit {
  private readonly logger = new Logger(CatalogEventsSubscriber.name);

  constructor(
    private readonly searchService: SearchService,
    @Optional() private readonly outboxWorker?: OutboxWorker,
  ) {}

  onModuleInit() {
    if (this.outboxWorker) {
      // Register with OutboxWorker for persistent at-least-once outbox dispatch
      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        {
          handle: (event: OutboxEvent): Promise<void> => {
            return this.handleItemCreated(event.payload as any);
          },
        },
      );

      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: (event: OutboxEvent): Promise<void> => {
            return this.handleItemDeleted(event.payload as any);
          },
        },
      );
    }
  }

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED, { async: true })
  async handleItemCreated(
    event: BaseIntegrationEvent<ItemCreatedIntegrationPayload>,
  ): Promise<void> {
    if (!event?.payload?.itemId) return;

    this.logger.log(
      `[DiscoverySubscriber] Reacting to CATALOG_ITEM_CREATED event for item ${event.payload.itemId} (title: "${event.payload.title}")`,
    );

    try {
      const scopeId =
        (event.payload as any)?.projectId ||
        event.scope?.projectId ||
        (event.payload as any)?.userId ||
        event.scope?.userId ||
        (event as any)?.userId;
      if (scopeId) {
        await this.searchService.invalidateFacetsCache(scopeId);
      }
      // Local library search index is automatically updated via database write and FTS tsvector
      this.logger.debug(
        `[DiscoverySubscriber] Local search index ready for item ${event.payload.itemId}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `[DiscoverySubscriber] Search indexing deferred/skipped for item ${event.payload.itemId}: ${err?.message || err}`,
      );
    }
  }

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED, { async: true })
  async handleItemDeleted(
    event: BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
  ): Promise<void> {
    if (!event?.payload?.itemId) return;

    this.logger.log(
      `[DiscoverySubscriber] Reacting to CATALOG_ITEM_DELETED event for item ${event.payload.itemId}`,
    );

    try {
      const scopeId =
        (event.payload as any)?.projectId ||
        event.scope?.projectId ||
        (event.payload as any)?.userId ||
        event.scope?.userId ||
        (event as any)?.userId;
      if (scopeId) {
        await this.searchService.invalidateFacetsCache(scopeId);
      }
    } catch (err: any) {
      this.logger.warn(
        `[DiscoverySubscriber] Search facet cache invalidation failed on delete: ${err?.message || err}`,
      );
    }
  }
}
