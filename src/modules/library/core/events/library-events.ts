/**
 * Formal Typed Registry of all Domain Events produced within the Library Bounded Context.
 * Resides in Shared Kernel to decouple submodules (Catalog, Extraction, Ingestion, Search)
 * from the Sync sub-domain.
 */
export const LIBRARY_EVENT_TYPES = {
  // Items
  ITEM_CREATED: 'library.item.created',
  ITEM_UPDATED: 'library.item.updated',
  ITEM_DELETED: 'library.item.deleted',
  ITEM_RESTORED: 'library.item.restored',
  ITEM_PURGED: 'library.item.purged',
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

  // Notes
  NOTE_CREATED: 'library.note.created',
  NOTE_UPDATED: 'library.note.updated',
  NOTE_DELETED: 'library.note.deleted',

  // Attachments
  ATTACHMENT_CREATED: 'library.attachment.created',
  ATTACHMENT_REVISION_ADDED: 'library.attachment.revision_added',
  ATTACHMENT_DELETED: 'library.attachment.deleted',
  ATTACHMENT_PAGES_EXTRACTED: 'library.attachment.pages.extracted',

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
  COLLECTION_ITEMS_ASSIGNED: 'library.collection.items_assigned',
  COLLECTION_ITEMS_DETACHED: 'library.collection.items_detached',

  // Saved Searches
  SAVED_SEARCH_CREATED: 'library.saved_search.created',
  SAVED_SEARCH_UPDATED: 'library.saved_search.updated',
  SAVED_SEARCH_DELETED: 'library.saved_search.deleted',

  // Reading
  READING_STATE_UPDATED: 'library.reading.updated',
} as const;

export type LibraryEventType =
  (typeof LIBRARY_EVENT_TYPES)[keyof typeof LIBRARY_EVENT_TYPES];

export type LibraryItemSource =
  'doi' | 'url' | 'bibtex' | 'ris' | 'pdf' | 'manual' | 'external_sync';

export interface ItemCreatedOutboxPayload {
  itemId: string;
  userId?: string;
  projectId?: string;
  title: string;
  source: LibraryItemSource;
  doi?: string | null;
  [key: string]: unknown;
}

export function buildItemCreatedOutboxPayload(input: {
  itemId: string;
  userId?: string;
  projectId?: string;
  title: string;
  source: LibraryItemSource;
  doi?: string | null;
  [key: string]: unknown;
}): ItemCreatedOutboxPayload {
  return {
    itemId: input.itemId,
    userId: input.userId,
    projectId: input.projectId,
    title: input.title,
    source: input.source,
    ...(input.doi ? { doi: input.doi } : {}),
  };
}

export interface DomainEventEnvelope<T = unknown> {
  eventId: string;
  userId?: string;
  projectId?: string;
  scopeId?: string;
  aggregateId: string;
  eventType: string;
  payload: T;
  createdAt: Date;
  schemaVersion: number;
}
