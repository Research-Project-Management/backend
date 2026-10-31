import type {
  Prisma,
  LibraryChange,
  Tombstone,
  OutboxEvent,
} from '@prisma/client';
import type { ItemFieldDefinition } from '../types/schema.types';
import type {
  ItemDetail,
  ItemSummary,
  CreateItemData,
  UpdateItemData,
  QualityAuditCandidateItem,
  DuplicateCandidateItem,
  CreateNoteData,
  NoteEntity,
} from '../types/bibliographic.types';
import type {
  ExtractedPdfDocument,
  ExtractedPdfMetadata,
  TrustedExtractionResult,
  AttachmentEntity,
  CreateAttachmentInput,
  AnnotationEntity,
  CreateAnnotationData,
  UpdateAnnotationData,
  BatchAnnotationsData,
  BatchAnnotationsResult,
  AnnotationType,
} from '../types/extraction.types';
import type {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  IngestionRunSnapshot,
  DuplicateClusterResult,
  RetractionCheckResult,
  QualityAuditReport,
} from '../types/ingestion.types';

// ============================================================================
// 1. CATALOG PORT
// ============================================================================

export const CATALOG_FACADE = 'CATALOG_FACADE';
export const ITEM_CACHE_INVALIDATOR = Symbol('ITEM_CACHE_INVALIDATOR');
export type CatalogItemSummary = ItemDetail;

export interface ICatalogFacade {
  getItem<T = ItemDetail>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  getItemSummary<T = ItemSummary>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean>;
  getTags<T = unknown>(
    userId: string,
    options?: { includeInactive?: boolean; projectId?: string },
  ): Promise<T[]>;
  getItemState<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T | null>;
  createItem<T = ItemDetail, D = CreateItemData>(
    userId: string,
    data: D,
    options?: Record<string, unknown>,
    projectId?: string,
  ): Promise<T>;
  updateItem<T = ItemDetail, D = UpdateItemData>(
    userId: string,
    itemId: string,
    data: D,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<T>;
  deleteItem(userId: string, itemId: string, projectId?: string): Promise<void>;
  findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]>;
  countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number>;
  findMany<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]>;
  validateItemType?(type: string): Promise<boolean>;
  getPrimaryCreatorType?(itemType: string): string;
  getOrderedFields?(itemType: string): ItemFieldDefinition[];
  findQualityAuditItems<T = QualityAuditCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  findDuplicateCandidateItems<T = DuplicateCandidateItem>(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<T[]>;
  mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<unknown>;
  createNote?(userId: string, data: CreateNoteData): Promise<NoteEntity>;
  listNotes?(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]>;
  listCollections?(userId: string, projectId?: string): Promise<unknown[]>;
  assignItemsToCollection?(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown>;
  findMatchCandidates?(
    scope: { userId?: string; projectId?: string | null },
    criteria: {
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      titleWords?: string[];
      titlePrefix?: string;
    },
  ): Promise<{
    exactMatch?: {
      id: string;
      title: string;
      matchReason: 'DOI_EXACT' | 'ARXIV_EXACT' | 'PMID_EXACT' | 'ISBN_EXACT';
      evidence: Record<string, unknown>;
    } | null;
    candidateItems: Array<{
      id: string;
      title: string;
      score?: number;
      reasons?: string[];
      doi?: string | null;
      arxivId?: string | null;
      pmid?: string | null;
      isbn?: string | null;
      year?: number | null;
      itemType?: string | null;
      authors?: string[];
      citationKey?: string | null;
      creators?: unknown[];
    }>;
  }>;
  invalidateForWrite?(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
  }): Promise<void>;
  findAttachmentByFileId?(
    fileId: string,
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null>;
  updateAttachmentProcessingStatus?(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void>;
  updateItemAiMetadata?(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
  ): Promise<void>;
}

export interface IItemCacheInvalidator {
  invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
  }): Promise<void>;
}

// ============================================================================
// 2. EXTRACTION PORT
// ============================================================================

export const EXTRACTION_FACADE = 'EXTRACTION_FACADE';

export interface IExtractionFacade {
  getItemAttachments(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<AttachmentEntity[]>;
  getItemAttachment(
    userId: string,
    attachmentId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<AttachmentEntity | null>;
  createAttachment(
    data: CreateAttachmentInput,
    projectId?: string,
  ): Promise<AttachmentEntity>;
  extractDocumentFromBuffer(
    buffer: Buffer,
    options?: {
      maxPages?: number;
      headerOnly?: boolean;
      skipTrustedExtraction?: boolean;
    },
  ): Promise<ExtractedPdfDocument>;
  extractMetadataFromBuffer(buffer: Buffer): ExtractedPdfMetadata;
  extractTrustedMetadata(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<TrustedExtractionResult>;
  captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
    projectId?: string,
  ): Promise<AttachmentEntity>;
  reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]>;
  cleanupOrphanedFiles?(fileIds: string[]): Promise<void>;
  getAnnotationsByAttachment(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    projectId?: string,
  ): Promise<AnnotationEntity[]>;
  getAnnotation(
    userId: string,
    annotationId: string,
    projectId?: string,
  ): Promise<AnnotationEntity | null>;
  createAnnotation(
    userId: string,
    data: CreateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity>;
  updateAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion: number,
    data: UpdateAnnotationData,
    projectId?: string,
  ): Promise<AnnotationEntity>;
  deleteAnnotation(
    userId: string,
    annotationId: string,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<boolean>;
  batchUpsertAnnotations(
    userId: string,
    attachmentId: string,
    data: BatchAnnotationsData,
    projectId?: string,
  ): Promise<BatchAnnotationsResult>;
}

// ============================================================================
// 3. INGESTION PORT
// ============================================================================

export const INGESTION_FACADE = 'INGESTION_FACADE';
export const METADATA_PORT = 'METADATA_PORT';

export interface ReResolveMetadataOptions {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title?: string;
  forceRefresh?: boolean;
  attachOaPdf?: boolean;
  expectedVersion?: number;
  projectId?: string;
}

export interface ReconcileExtractedCandidatePayload {
  userId: string;
  projectId?: string;
  itemId: string;
  attachmentId?: string;
  extractedMetadata: {
    title?: string;
    doi?: string;
    arxivId?: string;
    pmid?: string | number;
    isbn?: string;
    issn?: string;
    abstract?: string;
    year?: number;
    publicationTitle?: string;
    authors?: string[];
    creators?: unknown[];
    [key: string]: unknown;
  };
  discoveredIdentifiers?: Array<{
    type: string;
    value: string;
    canonicalUri?: string;
  }>;
  isOcrExtracted?: boolean;
  isOcrDerived?: boolean;
  engineUsed?: string;
  qualityScore?: number;
}

export interface IIngestionFacade {
  submitIngestion(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean },
  ): Promise<IngestionAcceptedResult>;
  getIngestionStatus(
    userId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot>;
  findDuplicates(
    userId: string,
    projectId?: string,
  ): Promise<DuplicateClusterResult[]>;
  getQualityAudit(
    userId: string,
    projectId?: string,
  ): Promise<QualityAuditReport>;
  checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<RetractionCheckResult>;
  reResolveMetadata(
    userId: string,
    itemId: string,
    options?: ReResolveMetadataOptions,
    projectId?: string,
  ): Promise<unknown>;
  reconcileExtractedCandidate?(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<{
    updated: boolean;
    updatedFields: string[];
    rejectedCitedDoi?: string;
    enrichedFromRegistry?: boolean;
  }>;
}

// ============================================================================
// 4. SEARCH PORT
// ============================================================================

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface ISearchFacade {
  search(
    userId: string,
    queryDto: Record<string, unknown>,
  ): Promise<{
    items: CatalogItemSummary[];
    facets?: unknown;
    meta?: {
      cursor?: string;
      hasNextPage: boolean;
      pageCount: number;
    };
  }>;
  indexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<void>;
  reindexItem(item: {
    id: string;
    userId?: string;
    projectId?: string;
  }): Promise<{
    localIndexed: boolean;
    error?: string;
  }>;
  indexAttachmentPages?(
    attachmentId: string,
    pages: Array<{
      pageIndex: number;
      textContent: string;
      charOffset?: number;
    }>,
  ): Promise<void>;
}

// ============================================================================
// 5. CITATION PORT
// ============================================================================

export const CITATION_FACADE = 'CITATION_FACADE';

export interface ICitationFacade<
  TStyleId = string,
  TFormattedResult = unknown,
  TExportDto = Record<string, unknown>,
  TExportResult = unknown,
> {
  formatCitation(
    userId: string,
    itemId: string,
    styleId?: TStyleId,
    index?: number,
    projectId?: string,
  ): Promise<TFormattedResult>;
  exportByCitationKeys(
    userId: string,
    citeKeys: string[],
    projectId?: string,
  ): Promise<{
    content: string;
    count: number;
    foundKeys: string[];
    missingKeys: string[];
  }>;
  exportLibrary(
    userId: string,
    options?: TExportDto,
  ): Promise<TExportResult>;
}

// ============================================================================
// 6. UNIT OF WORK PORT
// ============================================================================

export interface AppendChangeEntry {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete' | (string & {});
  version: number;
  data?: unknown;
}

export interface AppendChangeInput extends AppendChangeEntry {
  userId?: string;
  projectId?: string | null;
}

export interface RecordTombstoneEntry {
  entityType: string;
  entityId: string;
  deletedById?: string;
}

export interface RecordTombstoneInput extends RecordTombstoneEntry {
  userId?: string;
  projectId?: string | null;
}

export interface PublishOutboxInput {
  userId: string;
  projectId?: string | null;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  dedupeKey?: string | null;
}

export interface TransactionHelpers {
  appendChange(
    scope: { userId?: string; projectId?: string | null },
    entry: AppendChangeEntry,
  ): Promise<LibraryChange>;
  appendChangesBatch(
    scopeOrEntries:
      { userId?: string; projectId?: string | null } | AppendChangeInput[],
    entries?: AppendChangeEntry[],
  ): Promise<number>;
  recordTombstone(
    scope: { userId?: string; projectId?: string | null },
    entry: RecordTombstoneEntry,
  ): Promise<Tombstone>;
  recordTombstonesBatch(
    scopeOrEntries:
      { userId?: string; projectId?: string | null } | RecordTombstoneInput[],
    entries?: RecordTombstoneEntry[],
  ): Promise<number>;
  removeTombstone(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityId: string,
  ): Promise<number>;
  removeTombstonesBatch(
    scope: { userId?: string; projectId?: string | null },
    entityType: string,
    entityIds: string[],
  ): Promise<number>;
  publishOutbox(
    scope: {
      userId: string;
      projectId?: string | null;
      dedupeKey?: string | null;
    },
    aggregateId: string,
    eventType: string,
    payload: unknown,
    options?: { dedupeKey?: string | null },
  ): Promise<OutboxEvent>;
  publishOutboxBatch(
    scopeOrEvents:
      { userId: string; projectId?: string | null } | PublishOutboxInput[],
    events?: Array<{
      aggregateId: string;
      eventType: string;
      payload: unknown;
      projectId?: string | null;
      dedupeKey?: string | null;
    }>,
  ): Promise<string[]>;
  onAfterCommit?(callback: () => Promise<void> | void): void;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export interface IUnitOfWork {
  executeInTransaction<T>(
    operation: (
      tx: Prisma.TransactionClient,
      helpers: TransactionHelpers,
    ) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
  getChangesSince?(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq?: bigint,
    limit?: number,
  ): Promise<LibraryChange[]>;
  getTombstonesSince?(
    scope: { userId?: string; projectId?: string | null },
    sinceSeq?: bigint,
    limit?: number,
  ): Promise<Tombstone[]>;
  getMinRetainedSequence?(scope: {
    userId?: string;
    projectId?: string | null;
  }): Promise<bigint | null>;
  getLatestSequence?(scope: {
    userId?: string;
    projectId?: string | null;
  }): Promise<bigint>;
}

// ============================================================================
// 7. OUTBOX PORT
// ============================================================================

export interface OutboxEventRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  status: string;
  retryCount: number;
  userId: string;
  projectId?: string | null;
  createdAt: Date;
  processedAt?: Date | null;
  [key: string]: unknown;
}

export interface OutboxDispatchHandler {
  handle(event: OutboxEventRecord, signal?: AbortSignal): Promise<void>;
}

export const OUTBOX_REGISTRY_PORT = Symbol('OUTBOX_REGISTRY_PORT');

export interface IOutboxRegistry {
  registerHandler(eventType: string, handler: OutboxDispatchHandler): void;
  hasHandler?(eventType: string): boolean;
}

// ============================================================================
// 8. IDEMPOTENT CONSUMER PORT
// ============================================================================

export interface IdempotentConsumerOptions<T = unknown> {
  consumer: string;
  eventId: string;
  leaseTtlSeconds?: number;
  retentionTtlSeconds?: number;
  handler: () => Promise<T>;
}

export interface IdempotentResult<T = unknown> {
  executed: boolean;
  skipped: boolean;
  reason?: 'ALREADY_COMPLETED' | 'IN_FLIGHT';
  result?: T;
}

export const IDEMPOTENT_CONSUMER = Symbol('IDEMPOTENT_CONSUMER');

export interface IIdempotentConsumer {
  executeIdempotent<T>(
    options: IdempotentConsumerOptions<T>,
  ): Promise<IdempotentResult<T>>;
}
