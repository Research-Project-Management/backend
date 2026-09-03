import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from '../workers/outbox.worker';
import { SyncMetricsService } from '../metrics/sync.metrics';

/**
 * Formal Typed Catalog of all Domain Events produced within the Library Bounded Context.
 */
export const SYNC_EVENT_TYPES = {
  // Catalog Items
  ITEM_CREATED: 'library.item.created',
  ITEM_UPDATED: 'library.item.updated',
  ITEM_DELETED: 'library.item.deleted',
  ITEM_INGESTED_URL: 'library.item.ingested_url',
  ITEM_INGESTED_DOI: 'library.item.ingested_doi',
  ITEM_INGESTED_BIBTEX: 'library.item.ingested_bibtex',
  ITEM_MERGED_INTO: 'library.item.merged_into',
  ITEM_MERGED: 'library.item.merged',

  // Tags & Item Tags
  TAG_CREATED: 'library.tag.created',
  TAG_DELETED: 'library.tag.deleted',
  ITEM_TAGGED: 'library.item.tagged',
  ITEM_UNTAGGED: 'library.item.untagged',
  TAG_ASSIGNED: 'library.tag.assigned',
  TAG_UNASSIGNED: 'library.tag.unassigned',

  // Notes
  NOTE_CREATED: 'library.note.created',
  NOTE_UPDATED: 'library.note.updated',
  NOTE_DELETED: 'library.note.deleted',

  // Attachments
  ATTACHMENT_CREATED: 'library.attachment.created',
  ATTACHMENT_REVISION_ADDED: 'library.attachment.revision_added',
  ATTACHMENT_DELETED: 'library.attachment.deleted',

  // Annotations
  ANNOTATION_CREATED: 'library.annotation.created',
  ANNOTATION_UPDATED: 'library.annotation.updated',
  ANNOTATION_DELETED: 'library.annotation.deleted',

  // Collections
  COLLECTION_CREATED: 'library.collection.created',
  COLLECTION_UPDATED: 'library.collection.updated',
  COLLECTION_DELETED: 'library.collection.deleted',
  COLLECTION_ITEM_ADDED: 'library.collection.item_added',
  COLLECTION_ITEM_REMOVED: 'library.collection.item_removed',
} as const;

export type LibraryEventType =
  (typeof SYNC_EVENT_TYPES)[keyof typeof SYNC_EVENT_TYPES];

export type LibraryItemSource =
  'doi' | 'url' | 'bibtex' | 'ris' | 'pdf' | 'manual' | 'external_sync';

export interface ItemCreatedOutboxPayload {
  itemId: string;
  workspaceId: string;
  title: string;
  source: LibraryItemSource;
  doi?: string | null;
  [key: string]: any;
}

export function buildItemCreatedOutboxPayload(input: {
  itemId: string;
  workspaceId: string;
  title: string;
  source: LibraryItemSource;
  doi?: string | null;
  [key: string]: any;
}): ItemCreatedOutboxPayload {
  return {
    itemId: input.itemId,
    workspaceId: input.workspaceId,
    title: input.title,
    source: input.source,
    ...(input.doi ? { doi: input.doi } : {}),
  };
}

export interface EventCatalogEntry {
  eventType: string;
  producer: string;
  consumer: string;
  retryPolicy: 'immediate_dlq' | 'exponential_backoff' | 'dedup_window';
  idempotency: 'dedupe_key' | 'aggregate_version' | 'none';
  expectedSideEffect: string;
}

export const LIBRARY_EVENT_CATALOG: Record<string, EventCatalogEntry> = {
  [SYNC_EVENT_TYPES.ITEM_CREATED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_CREATED,
    producer: 'CatalogService.createItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners, search projection, and metrics',
  },
  [SYNC_EVENT_TYPES.ITEM_UPDATED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_UPDATED,
    producer: 'CatalogService.updateItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners and change log tracking',
  },
  [SYNC_EVENT_TYPES.ITEM_DELETED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_DELETED,
    producer: 'CatalogService.deleteItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for local tombstone listeners',
  },
  [SYNC_EVENT_TYPES.ITEM_INGESTED_URL]: {
    eventType: SYNC_EVENT_TYPES.ITEM_INGESTED_URL,
    producer: 'IngestionService.confirmCapturedUrl',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for URL ingestion completion telemetry',
  },
  [SYNC_EVENT_TYPES.ITEM_INGESTED_DOI]: {
    eventType: SYNC_EVENT_TYPES.ITEM_INGESTED_DOI,
    producer: 'IngestionService.ingestDoi',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for DOI ingestion completion telemetry',
  },
  [SYNC_EVENT_TYPES.ITEM_INGESTED_BIBTEX]: {
    eventType: SYNC_EVENT_TYPES.ITEM_INGESTED_BIBTEX,
    producer: 'IngestionService.ingestBibtex',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for BibTeX batch ingestion telemetry',
  },
  [SYNC_EVENT_TYPES.ITEM_MERGED_INTO]: {
    eventType: SYNC_EVENT_TYPES.ITEM_MERGED_INTO,
    producer: 'CurationService.mergeItems',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for duplicate item merge audit',
  },
  [SYNC_EVENT_TYPES.ITEM_MERGED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_MERGED,
    producer: 'CurationService.mergeItems',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item merge audit',
  },
  [SYNC_EVENT_TYPES.TAG_CREATED]: {
    eventType: SYNC_EVENT_TYPES.TAG_CREATED,
    producer: 'TagsService.createTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag creation telemetry',
  },
  [SYNC_EVENT_TYPES.TAG_DELETED]: {
    eventType: SYNC_EVENT_TYPES.TAG_DELETED,
    producer: 'TagsService.deleteTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag deletion telemetry',
  },
  [SYNC_EVENT_TYPES.ITEM_TAGGED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_TAGGED,
    producer: 'TagsService.assignTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item tag association',
  },
  [SYNC_EVENT_TYPES.ITEM_UNTAGGED]: {
    eventType: SYNC_EVENT_TYPES.ITEM_UNTAGGED,
    producer: 'TagsService.removeTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item untag association',
  },
  [SYNC_EVENT_TYPES.TAG_ASSIGNED]: {
    eventType: SYNC_EVENT_TYPES.TAG_ASSIGNED,
    producer: 'TagsService.assignTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_TAGGED',
  },
  [SYNC_EVENT_TYPES.TAG_UNASSIGNED]: {
    eventType: SYNC_EVENT_TYPES.TAG_UNASSIGNED,
    producer: 'TagsService.removeTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_UNTAGGED',
  },
  [SYNC_EVENT_TYPES.NOTE_CREATED]: {
    eventType: SYNC_EVENT_TYPES.NOTE_CREATED,
    producer: 'NotesService.createNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note creation telemetry',
  },
  [SYNC_EVENT_TYPES.NOTE_UPDATED]: {
    eventType: SYNC_EVENT_TYPES.NOTE_UPDATED,
    producer: 'NotesService.updateNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note update telemetry',
  },
  [SYNC_EVENT_TYPES.NOTE_DELETED]: {
    eventType: SYNC_EVENT_TYPES.NOTE_DELETED,
    producer: 'NotesService.deleteNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note deletion telemetry',
  },
  [SYNC_EVENT_TYPES.ATTACHMENT_CREATED]: {
    eventType: SYNC_EVENT_TYPES.ATTACHMENT_CREATED,
    producer: 'AttachmentsService.uploadAttachment',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment upload telemetry',
  },
  [SYNC_EVENT_TYPES.ATTACHMENT_REVISION_ADDED]: {
    eventType: SYNC_EVENT_TYPES.ATTACHMENT_REVISION_ADDED,
    producer: 'AttachmentsService.addRevision',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment revision telemetry',
  },
  [SYNC_EVENT_TYPES.ATTACHMENT_DELETED]: {
    eventType: SYNC_EVENT_TYPES.ATTACHMENT_DELETED,
    producer: 'AttachmentsService.deleteAttachment',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment deletion',
  },
  [SYNC_EVENT_TYPES.ANNOTATION_CREATED]: {
    eventType: SYNC_EVENT_TYPES.ANNOTATION_CREATED,
    producer: 'AnnotationsService.createAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation creation',
  },
  [SYNC_EVENT_TYPES.ANNOTATION_UPDATED]: {
    eventType: SYNC_EVENT_TYPES.ANNOTATION_UPDATED,
    producer: 'AnnotationsService.updateAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation update',
  },
  [SYNC_EVENT_TYPES.ANNOTATION_DELETED]: {
    eventType: SYNC_EVENT_TYPES.ANNOTATION_DELETED,
    producer: 'AnnotationsService.deleteAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation deletion',
  },
  [SYNC_EVENT_TYPES.COLLECTION_CREATED]: {
    eventType: SYNC_EVENT_TYPES.COLLECTION_CREATED,
    producer: 'CollectionsService.createCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection creation',
  },
  [SYNC_EVENT_TYPES.COLLECTION_UPDATED]: {
    eventType: SYNC_EVENT_TYPES.COLLECTION_UPDATED,
    producer: 'CollectionsService.updateCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection update',
  },
  [SYNC_EVENT_TYPES.COLLECTION_DELETED]: {
    eventType: SYNC_EVENT_TYPES.COLLECTION_DELETED,
    producer: 'CollectionsService.deleteCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection deletion',
  },
  [SYNC_EVENT_TYPES.COLLECTION_ITEM_ADDED]: {
    eventType: SYNC_EVENT_TYPES.COLLECTION_ITEM_ADDED,
    producer: 'CollectionsService.addItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item association',
  },
  [SYNC_EVENT_TYPES.COLLECTION_ITEM_REMOVED]: {
    eventType: SYNC_EVENT_TYPES.COLLECTION_ITEM_REMOVED,
    producer: 'CollectionsService.removeItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item disassociation',
  },
};

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Emits typed domain events via EventEmitter2 and increments telemetry metrics.
 */
@Injectable()
export class EventDispatcher implements OutboxDispatchHandler {
  private readonly logger = new Logger(EventDispatcher.name);

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly metricsService?: SyncMetricsService,
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

    // Emit event to internal event bus for any registered listeners
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
