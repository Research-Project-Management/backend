import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LIBRARY_EVENT_TYPES,
  DomainEventEnvelope,
  IOutboxRegistry,
  OUTBOX_REGISTRY_PORT,
} from '@/modules/library/core';
import { OutboxEvent } from '@prisma/client';
import {
  INTEGRATION_EVENT_TOPICS,
  BaseIntegrationEvent,
  ItemCreatedIntegrationPayload,
  ItemDeletedIntegrationPayload,
} from '@/modules/library/core/events/integration-events';
import { SearchService } from '@/modules/library/search/services/search.service';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';

/**
 * Unified SearchEventsSubscriber for Search Bounded Context.
 * Cohesively coordinates both full-text index updates/cleanup and Redis facet cache invalidations
 * across local domain events and durable Outbox integration events.
 */
@Injectable()
export class SearchEventsSubscriber implements OnModuleInit {
  private readonly logger = new Logger(SearchEventsSubscriber.name);

  constructor(
    private readonly searchService: SearchService,
    @Optional()
    private readonly searchRepo?: SearchRepository,
    @Optional()
    @Inject(OUTBOX_REGISTRY_PORT)
    private readonly outboxWorker?: IOutboxRegistry,
  ) {}

  onModuleInit(): void {
    if (this.outboxWorker) {
      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED,
        {
          handle: async (event: OutboxEvent) => {
            await this.handleIntegrationItemCreated(
              event.payload as unknown as BaseIntegrationEvent<ItemCreatedIntegrationPayload>,
            );
          },
        },
      );

      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: async (event: OutboxEvent) => {
            await this.handleIntegrationItemDeleted(
              event.payload as unknown as BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
            );
          },
        },
      );

      this.outboxWorker.registerHandler('library.item.purged', {
        handle: async (event: OutboxEvent) => {
          await this.handleItemPurged(event.payload);
        },
      });
    }
  }

  // Integration Events (Cross-BC / Outbox)

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_CREATED, { async: true })
  async handleIntegrationItemCreated(
    event: BaseIntegrationEvent<ItemCreatedIntegrationPayload>,
  ): Promise<void> {
    const itemId = event?.payload?.itemId;
    if (!itemId) return;

    const scopeId = this.resolveScopeId(event);
    this.logger.log(
      `[SearchEvents] Invalidating facet cache for created item ${itemId} (scope: ${scopeId ?? 'global'})`,
    );

    try {
      if (
        scopeId &&
        typeof this.searchService?.invalidateFacetsCache === 'function'
      ) {
        await this.searchService.invalidateFacetsCache(scopeId);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `[SearchEvents] Failed to invalidate facet cache on item create: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED, { async: true })
  async handleIntegrationItemDeleted(
    event: BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
  ): Promise<void> {
    const itemId = event?.payload?.itemId;
    if (!itemId) return;

    const scopeId = this.resolveScopeId(event);
    this.logger.log(
      `[SearchEvents] Cleaning up search index and facet cache for deleted item ${itemId} (scope: ${scopeId ?? 'global'})`,
    );

    const cleanupTasks: Promise<unknown>[] = [];
    if (this.searchRepo) {
      cleanupTasks.push(
        this.searchRepo
          .deleteFullTextIndexByItemId(itemId)
          .catch((err: unknown) =>
            this.logger.error(
              `[SearchEvents] FTS cleanup error for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
      );
    }
    if (
      scopeId &&
      typeof this.searchService?.invalidateFacetsCache === 'function'
    ) {
      cleanupTasks.push(
        this.searchService
          .invalidateFacetsCache(scopeId)
          .catch((err: unknown) =>
            this.logger.warn(
              `[SearchEvents] Facet cache invalidation error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ),
      );
    }
    await Promise.allSettled(cleanupTasks);
  }

  @OnEvent('library.item.purged', { async: true })
  async handleItemPurged(event: unknown): Promise<void> {
    const payload = event as
      | {
          id?: string;
          aggregateId?: string;
          scopeId?: string;
          payload?: { id?: string; projectId?: string | null; userId?: string };
        }
      | null
      | undefined;
    const itemId = payload?.id || payload?.aggregateId || payload?.payload?.id;
    if (!itemId) return;

    this.logger.debug(
      `[SearchEvents] Purged item: Cleaning FTS index for item ${itemId}`,
    );
    if (this.searchRepo) {
      try {
        await this.searchRepo.deleteFullTextIndexByItemId(itemId);
      } catch (err: unknown) {
        this.logger.error(
          `[SearchEvents] Purged item FTS cleanup failed for ${itemId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const scopeId =
      payload?.scopeId ||
      payload?.payload?.projectId ||
      payload?.payload?.userId;
    if (
      scopeId &&
      typeof this.searchService?.invalidateFacetsCache === 'function'
    ) {
      try {
        await this.searchService.invalidateFacetsCache(scopeId);
      } catch (err: unknown) {
        this.logger.warn(
          `[SearchEvents] Failed to invalidate facet cache on item purge: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Domain Events (Local Sync & Extraction Lifecycle)

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  async handleDomainItemDeleted(event: DomainEventEnvelope): Promise<void> {
    const itemId = event.aggregateId;
    if (!itemId) return;

    this.logger.debug(
      `[SearchEvents] Domain event: Cleaning FTS index for item ${itemId}`,
    );
    if (this.searchRepo) {
      try {
        await this.searchRepo.deleteFullTextIndexByItemId(itemId);
      } catch (err: unknown) {
        this.logger.error(
          `[SearchEvents] Domain item delete FTS cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const scopeId = event.scopeId;
    if (
      scopeId &&
      typeof this.searchService?.invalidateFacetsCache === 'function'
    ) {
      try {
        await this.searchService.invalidateFacetsCache(scopeId);
      } catch (err: unknown) {
        this.logger.warn(
          `[SearchEvents] Failed to invalidate facet cache on domain delete: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED, { async: true })
  async handleDomainAttachmentDeleted(
    event: DomainEventEnvelope,
  ): Promise<void> {
    const attachmentId = event.aggregateId;
    if (!attachmentId) return;

    this.logger.debug(
      `[SearchEvents] Cleaning up FTS index for deleted attachment ${attachmentId}`,
    );
    if (this.searchRepo) {
      try {
        await this.searchRepo.deleteFullTextIndexByAttachmentId(attachmentId);
      } catch (err: unknown) {
        this.logger.error(
          `[SearchEvents] Attachment FTS cleanup failed for ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_CREATED, { async: true })
  handleDomainItemCreated(event: DomainEventEnvelope): void {
    this.logger.debug(
      `[SearchEvents] Domain item created: ${event.aggregateId} (scope: ${event.scopeId || 'global'})`,
    );
  }

  private resolveScopeId(
    event: BaseIntegrationEvent<unknown>,
  ): string | undefined {
    const payload = event.payload as
      { projectId?: string | null; userId?: string } | undefined;
    return (
      event.scope?.projectId ||
      payload?.projectId ||
      event.scope?.userId ||
      payload?.userId
    );
  }
}
