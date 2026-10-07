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
} from '../../shared-kernel';
import { OutboxEvent } from '@prisma/client';
import {
  INTEGRATION_EVENT_TOPICS,
  BaseIntegrationEvent,
  ItemCreatedIntegrationPayload,
  ItemDeletedIntegrationPayload,
} from '../../shared-kernel/events/integration-events';
import { SearchService } from './search.service';
import { SearchRepository } from '../repositories/search.repository';

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
            await this.handleIntegrationItemCreated(event.payload as any);
          },
        },
      );

      this.outboxWorker.registerHandler(
        INTEGRATION_EVENT_TOPICS.CATALOG_ITEM_DELETED,
        {
          handle: async (event: OutboxEvent) => {
            await this.handleIntegrationItemDeleted(event.payload as any);
          },
        },
      );
    }
  }

  // ─── Integration Events (Cross-BC / Outbox) ────────────────────────────────

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
      if (scopeId) {
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

    const cleanupTasks: Promise<any>[] = [];
    if (this.searchRepo) {
      cleanupTasks.push(
        this.searchRepo
          .deleteFullTextIndexByItemId(itemId)
          .catch((err) =>
            this.logger.error(
              `[SearchEvents] FTS cleanup error for item ${itemId}: ${err?.message || err}`,
            ),
          ),
      );
    }
    if (scopeId) {
      cleanupTasks.push(
        this.searchService
          .invalidateFacetsCache(scopeId)
          .catch((err) =>
            this.logger.warn(
              `[SearchEvents] Facet cache invalidation error: ${err?.message || err}`,
            ),
          ),
      );
    }
    await Promise.allSettled(cleanupTasks);
  }

  /** Backward-compatible alias for unit tests and callers */
  async handleItemCreated(
    event: BaseIntegrationEvent<ItemCreatedIntegrationPayload>,
  ): Promise<void> {
    return this.handleIntegrationItemCreated(event);
  }

  /** Backward-compatible alias for unit tests and callers */
  async handleItemDeleted(
    event: BaseIntegrationEvent<ItemDeletedIntegrationPayload>,
  ): Promise<void> {
    return this.handleIntegrationItemDeleted(event);
  }

  // ─── Domain Events (Local Sync & Extraction Lifecycle) ─────────────────────

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
    if (scopeId) {
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

  private resolveScopeId(event: BaseIntegrationEvent<any>): string | undefined {
    return (
      event.scope?.projectId ||
      event.payload?.projectId ||
      event.scope?.userId ||
      event.payload?.userId
    );
  }
}

// Aliases for backwards compatibility with tests and consumers
export { SearchEventsSubscriber as CatalogEventsSubscriber };
export { SearchEventsSubscriber as EventHandler };
