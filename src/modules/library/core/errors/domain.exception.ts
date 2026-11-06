import { HttpStatus } from '@nestjs/common';

/**
 * Universal Base Domain Exception for all Bounded Contexts in the Library module.
 *
 * Clean Architecture & DDD Core Policy:
 * Shared Kernel provides the base exception abstraction so that infrastructure filters
 * can handle domain errors without importing child context domain exceptions.
 */
export abstract class BaseDomainException extends Error {
  readonly code: string = 'LIBRARY_DOMAIN_ERROR';
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface VersionMismatchOptions {
  aggregateType?: string;
  entityId?: string;
  currentVersion?: number;
  providedVersion?: number;
  expectedVersion?: number;
  message?: string;
}

export class VersionMismatchException extends BaseDomainException {
  override readonly code = 'VERSION_MISMATCH';
  public readonly statusCode = HttpStatus.PRECONDITION_FAILED;
  public readonly currentVersion?: number;
  public readonly expectedVersion?: number;

  constructor(
    messageOrOptions?: string | VersionMismatchOptions,
    currentVersion?: number,
    expectedVersion?: number,
  ) {
    let message =
      'The item has been modified by another process. Please reload and try again.';
    let currentVer = currentVersion;
    let expectedVer = expectedVersion;
    let aggregateType: string | undefined;
    let entityId: string | undefined;

    if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
      aggregateType = messageOrOptions.aggregateType;
      entityId = messageOrOptions.entityId;
      currentVer = messageOrOptions.currentVersion ?? currentVer;
      expectedVer =
        messageOrOptions.providedVersion ??
        messageOrOptions.expectedVersion ??
        expectedVer;
      message =
        messageOrOptions.message ||
        `Version conflict on ${aggregateType || 'entity'} (${entityId || 'unknown'}): current version is ${currentVer}, expected ${expectedVer}`;
    } else if (typeof messageOrOptions === 'string') {
      message = messageOrOptions;
    }

    super(message, {
      statusCode: HttpStatus.PRECONDITION_FAILED,
      error: 'Precondition Failed',
      code: 'VERSION_MISMATCH',
      ...(aggregateType ? { aggregateType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(currentVer !== undefined ? { currentVersion: currentVer } : {}),
      ...(expectedVer !== undefined ? { expectedVersion: expectedVer } : {}),
    });

    this.currentVersion = currentVer;
    this.expectedVersion = expectedVer;
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): Record<string, unknown> {
    return {
      statusCode: this.statusCode,
      error: 'Precondition Failed',
      message: this.message,
      code: this.code,
      currentVersion: this.currentVersion,
      expectedVersion: this.expectedVersion,
    };
  }
}

export { VersionMismatchException as OptimisticLockException };

/**
 * Thrown when an illegal state transition is attempted on an IngestionRun, Item, or Attachment aggregate.
 */
export class InvalidStateTransitionException extends BaseDomainException {
  override readonly code = 'LIBRARY_INVALID_STATE_TRANSITION';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an external academic provider (Crossref, OpenAlex, PubMed, Unpaywall, etc.) fails or returns invalid data.
 */
export class ExternalProviderException extends BaseDomainException {
  override readonly code = 'LIBRARY_EXTERNAL_PROVIDER_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when extraction (PDF parsing, OCR, layout heuristics, or web snapshots) encounters an unrecoverable error.
 */
export class ExtractionProcessException extends BaseDomainException {
  override readonly code = 'LIBRARY_EXTRACTION_PROCESS_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an internal library subsystem or worker pool is unavailable.
 */
export class SubsystemUnavailableException extends BaseDomainException {
  override readonly code = 'LIBRARY_SUBSYSTEM_UNAVAILABLE';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an entity (item, attachment, note, collection, tag) is not found.
 */
export class EntityNotFoundException extends BaseDomainException {
  override readonly code = 'LIBRARY_ENTITY_NOT_FOUND';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when system configuration, database client, or transaction context is missing or invalid.
 */
export class ConfigurationException extends BaseDomainException {
  override readonly code = 'LIBRARY_CONFIGURATION_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

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
  ITEM_REINDEXED: 'library.item.reindexed',
  ITEM_INGESTED_URL: 'library.item.ingested_url',
  ITEM_INGESTED_DOI: 'library.item.ingested_doi',
  ITEM_INGESTED_BIBTEX: 'library.item.ingested_bibtex',
  ITEM_MERGED_INTO: 'library.item.merged_into',
  ITEM_MERGED: 'library.item.merged',

  // Tags & Item Tags
  TAG_CREATED: 'library.tag.created',
  TAG_UPDATED: 'library.tag.updated',
  TAG_DELETED: 'library.tag.deleted',
  ITEM_TAGGED: 'library.item.tagged',
  ITEM_UNTAGGED: 'library.item.untagged',

  // Notes
  NOTE_CREATED: 'library.note.created',
  NOTE_UPDATED: 'library.note.updated',
  NOTE_DELETED: 'library.note.deleted',

  // Attachments
  ATTACHMENT_CREATED: 'library.attachment.created',
  ATTACHMENT_UPDATED: 'library.attachment.updated',
  ATTACHMENT_EXTRACTION_REQUESTED: 'library.attachment.extraction_requested',
  ATTACHMENT_REVISION_ADDED: 'library.attachment.revision_added',
  ATTACHMENT_DELETED: 'library.attachment.deleted',
  ATTACHMENT_PAGES_EXTRACTED: 'library.attachment.pages.extracted',
  ATTACHMENT_METADATA_EXTRACTED: 'library.attachment.metadata_extracted',

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

export type LibraryItemSource =
  'doi' | 'url' | 'bibtex' | 'ris' | 'pdf' | 'manual' | 'external_sync';

interface ItemCreatedOutboxPayload {
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

export class AttachmentInvariantError extends BaseDomainException {
  public override name = 'AttachmentInvariantError';
  constructor(message: string) {
    super(message);
  }
}

export class AttachmentStorageException extends BaseDomainException {
  constructor(message: string) {
    super(message);
  }
}

