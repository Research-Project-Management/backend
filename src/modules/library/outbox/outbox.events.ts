import { OutboxEvent } from '@prisma/client';

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
} as const;

/** @deprecated Use LIBRARY_EVENT_TYPES instead */
export const SYNC_EVENT_TYPES = LIBRARY_EVENT_TYPES;

export type LibraryEventType =
  (typeof LIBRARY_EVENT_TYPES)[keyof typeof LIBRARY_EVENT_TYPES];

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
  [LIBRARY_EVENT_TYPES.ITEM_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_CREATED,
    producer: 'CatalogService.createItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners, search projection, and metrics',
  },
  [LIBRARY_EVENT_TYPES.ITEM_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_UPDATED,
    producer: 'CatalogService.updateItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for local listeners and change log tracking',
  },
  [LIBRARY_EVENT_TYPES.ITEM_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_DELETED,
    producer: 'CatalogService.deleteItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for local tombstone listeners',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_URL]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_URL,
    producer: 'IngestionService.confirmCapturedUrl',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for URL ingestion completion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_DOI]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_DOI,
    producer: 'IngestionService.ingestDoi',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for DOI ingestion completion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_INGESTED_BIBTEX]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_INGESTED_BIBTEX,
    producer: 'IngestionService.ingestBibtex',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect:
      'Emits domain event for BibTeX batch ingestion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_MERGED_INTO]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_MERGED_INTO,
    producer: 'CurationService.mergeItems',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for duplicate item merge audit',
  },
  [LIBRARY_EVENT_TYPES.ITEM_MERGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_MERGED,
    producer: 'CurationService.mergeItems',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item merge audit',
  },
  [LIBRARY_EVENT_TYPES.TAG_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_CREATED,
    producer: 'TagsService.createTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag creation telemetry',
  },
  [LIBRARY_EVENT_TYPES.TAG_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_DELETED,
    producer: 'TagsService.deleteTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for tag deletion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ITEM_TAGGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_TAGGED,
    producer: 'TagsService.assignTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item tag association',
  },
  [LIBRARY_EVENT_TYPES.ITEM_UNTAGGED]: {
    eventType: LIBRARY_EVENT_TYPES.ITEM_UNTAGGED,
    producer: 'TagsService.removeTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for item untag association',
  },
  [LIBRARY_EVENT_TYPES.TAG_ASSIGNED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_ASSIGNED,
    producer: 'TagsService.assignTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_TAGGED',
  },
  [LIBRARY_EVENT_TYPES.TAG_UNASSIGNED]: {
    eventType: LIBRARY_EVENT_TYPES.TAG_UNASSIGNED,
    producer: 'TagsService.removeTag',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Alias for ITEM_UNTAGGED',
  },
  [LIBRARY_EVENT_TYPES.NOTE_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_CREATED,
    producer: 'NotesService.createNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note creation telemetry',
  },
  [LIBRARY_EVENT_TYPES.NOTE_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_UPDATED,
    producer: 'NotesService.updateNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note update telemetry',
  },
  [LIBRARY_EVENT_TYPES.NOTE_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.NOTE_DELETED,
    producer: 'NotesService.deleteNote',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for note deletion telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_CREATED,
    producer: 'AttachmentsService.uploadAttachment',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment upload telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_REVISION_ADDED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_REVISION_ADDED,
    producer: 'AttachmentsService.addRevision',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment revision telemetry',
  },
  [LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ATTACHMENT_DELETED,
    producer: 'AttachmentsService.deleteAttachment',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for attachment deletion',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_CREATED,
    producer: 'AnnotationsService.createAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation creation',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_UPDATED,
    producer: 'AnnotationsService.updateAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation update',
  },
  [LIBRARY_EVENT_TYPES.ANNOTATION_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.ANNOTATION_DELETED,
    producer: 'AnnotationsService.deleteAnnotation',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for annotation deletion',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_CREATED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_CREATED,
    producer: 'CollectionsService.createCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection creation',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_UPDATED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_UPDATED,
    producer: 'CollectionsService.updateCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection update',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_DELETED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_DELETED,
    producer: 'CollectionsService.deleteCollection',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection deletion',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_ITEM_ADDED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_ITEM_ADDED,
    producer: 'CollectionsService.addItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item association',
  },
  [LIBRARY_EVENT_TYPES.COLLECTION_ITEM_REMOVED]: {
    eventType: LIBRARY_EVENT_TYPES.COLLECTION_ITEM_REMOVED,
    producer: 'CollectionsService.removeItem',
    consumer: 'EventDispatcher',
    retryPolicy: 'exponential_backoff',
    idempotency: 'aggregate_version',
    expectedSideEffect: 'Emits domain event for collection item disassociation',
  },
};
