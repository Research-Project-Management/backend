import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxEvent } from '@prisma/client';
import { OutboxDispatchHandler } from './outbox.worker';
import { SyncMetricsService } from './sync.metrics';

/**
 * Formal Typed Catalog of all Domain Events produced within the Library Bounded Context.
 */
export const LIBRARY_EVENT_TYPES = {
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

  // Zotero Inbound Synchronization (Pull)
  ZOTERO_STREAM_RECEIVED: 'library.zotero.stream_event_received',
  ZOTERO_PULL_COMPLETED: 'library.zotero.pull_completed',
  ZOTERO_ITEM_SYNCED: 'library.zotero.item_synced',
  ZOTERO_COLLECTION_SYNCED: 'library.zotero.collection_synced',
  ZOTERO_ATTACHMENT_SYNCED: 'library.zotero.attachment_synced',
  ZOTERO_NOTE_SYNCED: 'library.zotero.note_synced',
  ZOTERO_ANNOTATION_SYNCED: 'library.zotero.annotation_synced',

  // Zotero Outbound Synchronization (Push)
  ZOTERO_PUSH_REQUESTED: 'library.zotero.push_requested',
  ZOTERO_PUSH_COMPLETED: 'library.zotero.push_completed',
  ZOTERO_ITEM_PUSHED: 'library.zotero.item_pushed',
  ZOTERO_ITEM_DELETED_PUSHED: 'library.zotero.item_deleted_pushed',

  // Zotero Conflicts & Policies
  ZOTERO_CONFLICT_DETECTED: 'library.zotero.conflict_detected',
  ZOTERO_CONFLICT_RESOLVED: 'library.zotero.conflict_resolved',
  ZOTERO_SYNC_DIRECTION_UPDATED: 'library.zotero.sync_direction_updated',
  ZOTERO_GLOBAL_KILL_SWITCH_TOGGLED:
    'library.zotero.global_kill_switch_toggled',
  ZOTERO_WORKSPACE_KILL_SWITCH_TOGGLED:
    'library.zotero.workspace_kill_switch_toggled',
} as const;

export type LibraryEventType =
  (typeof LIBRARY_EVENT_TYPES)[keyof typeof LIBRARY_EVENT_TYPES];

export type LibraryItemSource =
  'doi' | 'url' | 'bibtex' | 'pdf' | 'zotero' | 'manual';

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
  [LIBRARY_EVENT_TYPES.ITEM_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_CREATED,
    producer: 'CatalogService.createItem',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners, search projection, and metrics',
  },
  [LIBRARY_EVENT_TYPES.ITEM_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_UPDATED,
    producer: 'CatalogService.updateItem',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners and change log tracking',
  },
  [LIBRARY_EVENT_TYPES.ITEM_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
    producer: 'CatalogService.deleteItem',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for local tombstone listeners',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_URL]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_URL,
    producer: 'IngestionService.confirmCapturedUrl',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for URL ingestion completion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_DOI]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_DOI,
    producer: 'IngestionService.ingestDoi',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for DOI ingestion completion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_BIBTEX]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_BIBTEX,
    producer: 'IngestionService.ingestBibtex',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for BibTeX batch ingestion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_MERGED_INTO]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_MERGED_INTO,
    producer: 'CurationService.mergeItems',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for duplicate item merge audit',
  },
  [LIBRARY_EVENT_TYPES.ITEM_MERGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_MERGED,
    producer: 'CurationService.mergeItems',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item merge audit',
  },
  [LIBRARY_EVENT_TYPES.TAG_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_CREATED,
    producer: 'TagsService.createTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag creation telemetry',
  },
  [LIBRARY_EVENT_TYPES.TAG_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_DELETED,
    producer: 'TagsService.deleteTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag deletion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_TAGGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_TAGGED,
    producer: 'TagsService.assignTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item tag association',
  },
  [LIBRARY_EVENT_TYPES.ITEM_UNTAGGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_UNTAGGED,
    producer: 'TagsService.removeTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item untag association',
  },
  [LIBRARY_EVENT_TYPES.TAG_ASSIGNED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_ASSIGNED,
    producer: 'TagsService.assignTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_TAGGED',
  },
  [LIBRARY_EVENT_TYPES.TAG_UNASSIGNED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_UNASSIGNED,
    producer: 'TagsService.removeTag',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_UNTAGGED',
  },
  [LIBRARY_EVENT_TYPES.NOTE_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_CREATED,
    producer: 'NotesService.createNote',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note creation telemetry',
  },
  [LIBRARY_EVENT_TYPES.NOTE_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_UPDATED,
    producer: 'NotesService.updateNote',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note update telemetry',
  },
  [LIBRARY_EVENT_TYPES.NOTE_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_DELETED,
    producer: 'NotesService.deleteNote',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note deletion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED,
    producer: 'AttachmentsService.uploadAttachment',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment upload telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_REVISION_ADDED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_REVISION_ADDED,
    producer: 'AttachmentsService.addRevision',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment revision telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED,
    producer: 'AttachmentsService.deleteAttachment',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment deletion',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_CREATED,
    producer: 'AnnotationsService.createAnnotation',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation creation',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED,
    producer: 'AnnotationsService.updateAnnotation',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation update',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_DELETED,
    producer: 'AnnotationsService.deleteAnnotation',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation deletion',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_CREATED,
    producer: 'CollectionsService.createCollection',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection creation',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
    producer: 'CollectionsService.updateCollection',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection update',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_DELETED,
    producer: 'CollectionsService.deleteCollection',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection deletion',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_ITEM_ADDED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_ITEM_ADDED,
    producer: 'CollectionsService.addItem',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item association',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_ITEM_REMOVED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_ITEM_REMOVED,
    producer: 'CollectionsService.removeItem',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item disassociation',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_STREAM_RECEIVED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_STREAM_RECEIVED,
    producer: 'ZoteroWebSocketListener',
    consumer: 'ZoteroStreamOutboxHandler',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Triggers incremental delta pull sync for workspace',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_PULL_COMPLETED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_PULL_COMPLETED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect:
      'Emits domain event for sync status and telemetry updates',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_ITEM_SYNCED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_ITEM_SYNCED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for individual Zotero item sync',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_COLLECTION_SYNCED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_COLLECTION_SYNCED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for Zotero collection sync',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_ATTACHMENT_SYNCED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_ATTACHMENT_SYNCED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect:
      'Emits domain event for Zotero attachment metadata sync',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_NOTE_SYNCED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_NOTE_SYNCED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for Zotero note sync',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_ANNOTATION_SYNCED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_ANNOTATION_SYNCED,
    producer: 'ZoteroPullWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for Zotero PDF annotation sync',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_PUSH_REQUESTED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_PUSH_REQUESTED,
    producer: 'ZoteroPushWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for push queueing',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_PUSH_COMPLETED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_PUSH_COMPLETED,
    producer: 'ZoteroPushWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for push completion audit',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_ITEM_PUSHED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_ITEM_PUSHED,
    producer: 'ZoteroPushWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for pushed item audit',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_ITEM_DELETED_PUSHED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_ITEM_DELETED_PUSHED,
    producer: 'ZoteroPushWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for remote item deletion audit',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_CONFLICT_DETECTED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_CONFLICT_DETECTED,
    producer: 'ZoteroPushWorker',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for conflict inbox notification',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_CONFLICT_RESOLVED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_CONFLICT_RESOLVED,
    producer: 'ZoteroConflictService',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect: 'Emits domain event for conflict resolution audit',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_SYNC_DIRECTION_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_SYNC_DIRECTION_UPDATED,
    producer: 'ZoteroConnectionService',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect:
      'Emits domain event for sync direction configuration change',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_GLOBAL_KILL_SWITCH_TOGGLED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_GLOBAL_KILL_SWITCH_TOGGLED,
    producer: 'ZoteroSyncPolicy',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect:
      'Emits domain event for emergency global kill switch audit',
  },
  [LIBRARY_EVENT_TYPES.ZOTERO_WORKSPACE_KILL_SWITCH_TOGGLED]: {
    eventType: LIBRARY_EVENT_TYPES.ZOTERO_WORKSPACE_KILL_SWITCH_TOGGLED,
    producer: 'ZoteroSyncPolicy',
    consumer: 'LibraryDomainEventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'dedupe_key',
    expectedSideEffect:
      'Emits domain event for workspace-level kill switch audit',
  },
};

/**
 * Generic Domain Event Publisher/Dispatcher for internal Library Domain Events.
 * Emits typed domain events via EventEmitter2 and increments telemetry metrics.
 */
@Injectable()
export class LibraryDomainEventDispatcher implements OutboxDispatchHandler {
  private readonly logger = new Logger(LibraryDomainEventDispatcher.name);

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
