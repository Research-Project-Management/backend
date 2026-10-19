import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  LIBRARY_EVENT_TYPES,
  DomainEventEnvelope,
} from '@/modules/library/core';
import { SearchService } from '@/modules/library/search/services/search.service';
import { PageTextExtraction } from '@/modules/library/search/services/full-text.provider';
import { SearchRepository } from '@/modules/library/search/repositories/search.repository';

/**
 * Unified SearchEventsSubscriber for Search Bounded Context.
 * Coordinates full-text index cleanup and Redis search/facet cache invalidations
 * across domain events.
 */
@Injectable()
export class SearchEventsSubscriber {
  private readonly logger = new Logger(SearchEventsSubscriber.name);

  constructor(
    private readonly searchService: SearchService,
    @Optional()
    private readonly searchRepo?: SearchRepository,
  ) {}

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_CREATED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_UPDATED, { async: true })
  async handleItemChanged(event: DomainEventEnvelope): Promise<void> {
    const payload = event?.payload as
      | {
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        }
      | undefined;

    if (payload?.attachmentId && Array.isArray(payload.pages)) {
      try {
        await this.searchService.indexAttachmentPages(
          payload.attachmentId,
          payload.itemId || event.aggregateId,
          payload.pages,
        );
      } catch (err: unknown) {
        this.logger.error(
          `[SearchEvents] Failed to index attachment pages on ${event.eventType} for ${payload.attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const scopeId = this.resolveScopeId(event);
    if (!scopeId) return;

    try {
      await this.searchService?.invalidateFacetsCache?.(scopeId);
    } catch (err: unknown) {
      this.logger.warn(
        `[SearchEvents] Failed to invalidate facet cache on ${event.eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent('library.attachment.pages.extracted', { async: true })
  async handleAttachmentPagesExtracted(
    event:
      | DomainEventEnvelope<{
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        }>
      | {
          attachmentId?: string;
          itemId?: string;
          pages?: PageTextExtraction[];
        },
  ): Promise<void> {
    const rawPayload =
      event && 'payload' in event && event.payload && typeof event.payload === 'object'
        ? event.payload
        : (event as {
            attachmentId?: string;
            itemId?: string;
            pages?: PageTextExtraction[];
          });
    const attachmentId =
      rawPayload?.attachmentId ||
      (event && 'aggregateId' in event ? event.aggregateId : undefined);
    const itemId = rawPayload?.itemId || '';
    const pages = Array.isArray(rawPayload?.pages) ? rawPayload.pages : [];

    if (!attachmentId) return;

    try {
      await this.searchService.indexAttachmentPages(
        attachmentId,
        itemId,
        pages,
      );
    } catch (err: unknown) {
      this.logger.error(
        `[SearchEvents] Failed to index extracted pages for attachment ${attachmentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_DELETED, { async: true })
  @OnEvent(LIBRARY_EVENT_TYPES.ITEM_PURGED, { async: true })
  async handleItemDeletedOrPurged(event: DomainEventEnvelope): Promise<void> {
    const payload = event?.payload as
      | { id?: string; itemId?: string }
      | undefined;
    const itemId = event?.aggregateId || payload?.id || payload?.itemId;
    if (!itemId) return;

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

    const scopeId = this.resolveScopeId(event);
    if (scopeId && this.searchService?.invalidateFacetsCache) {
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

  private resolveScopeId(event: DomainEventEnvelope): string | undefined {
    const payload = event?.payload as
      | { projectId?: string | null; userId?: string }
      | undefined;
    return (
      event?.scopeId ||
      event?.projectId ||
      payload?.projectId ||
      event?.userId ||
      payload?.userId
    );
  }
}
