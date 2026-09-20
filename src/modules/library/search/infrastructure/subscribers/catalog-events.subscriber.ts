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
          handle: async (event: OutboxEvent) => {
            await this.handleItemCreated(event.payload as any);
          },
        },
      );

      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: (event: OutboxEvent): Promise<void> => {
            this.handleItemDeleted(event.payload as any);
            return Promise.resolve();
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
      // Background indexing trigger
      await this.searchService.indexPaperForRag({
        id: event.payload.itemId,
        userId: event.scope.userId,
        projectId: event.scope.projectId ?? undefined,
        title: event.payload.title,
        abstract: event.payload.abstract ?? undefined,
        doi: event.payload.doi ?? undefined,
      });
    } catch (err: any) {
      this.logger.warn(
        `[DiscoverySubscriber] Search indexing deferred/skipped for item ${event.payload.itemId}: ${err?.message || err}`,
      );
    }
  }

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED, { async: true })
  handleItemDeleted(
    event: BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
  ): void {
    if (!event?.payload?.itemId) return;

    this.logger.log(
      `[DiscoverySubscriber] Reacting to CATALOG_ITEM_DELETED event for item ${event.payload.itemId}`,
    );
  }
}
