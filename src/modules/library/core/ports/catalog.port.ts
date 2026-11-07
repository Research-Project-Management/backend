import type { Prisma, LibraryChange, Tombstone } from '@prisma/client';
import type {
  ItemFieldDefinition,
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  PublishOutboxInput,
  TransactionHelpers,
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  IngestionRunSnapshot,
  DuplicateClusterResult,
  RetractionCheckResult,
  QualityAuditReport,
} from '../types/schema.types';
import type { ItemDetail, ItemSummary, CreateItemData, UpdateItemData, QualityAuditCandidateItem, DuplicateCandidateItem, CreateNoteData, NoteEntity } from '../types/bibliographic.types';
import type { ExtractedPdfDocument, ExtractedPdfMetadata, PdfMetadataExtractionResult, AttachmentEntity, CreateAttachmentInput, AnnotationEntity, CreateAnnotationData, UpdateAnnotationData, BatchAnnotationsData, BatchAnnotationsResult, AnnotationType } from '../types/extraction.types';

export type {
  AppendChangeEntry,
  AppendChangeInput,
  RecordTombstoneEntry,
  RecordTombstoneInput,
  PublishOutboxInput,
  TransactionHelpers,
};

export const CATALOG_FACADE = 'CATALOG_FACADE';
export const CATALOG_READER_PORT = 'CATALOG_READER_PORT';
export const CATALOG_WRITER_PORT = 'CATALOG_WRITER_PORT';
export const CATALOG_COLLECTION_PORT = 'CATALOG_COLLECTION_PORT';
export const CATALOG_TRASH_PORT = 'CATALOG_TRASH_PORT';
export const CATALOG_IMPORT_EXPORT_PORT = 'CATALOG_IMPORT_EXPORT_PORT';
export const ITEM_CACHE_INVALIDATOR = Symbol('ITEM_CACHE_INVALIDATOR');
export type CatalogItemSummary = ItemDetail;

export interface ICatalogReaderPort {
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
  findByIds<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
    options?: { includeContent?: boolean },
  ): Promise<T[]>;
  getItemsByIds?<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
    options?: { includeContent?: boolean },
  ): Promise<T[]>;
  countItems(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<number>;
  findMany<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<T[]>;
  listItems?<T = ItemDetail>(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<{ items: T[]; meta?: Record<string, unknown> } | T[]>;
  listSubItems?<T = unknown>(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<T[]>;
  getStats?<T = unknown>(userId: string, projectId?: string): Promise<T>;
  getLibraryCounters?<T = unknown>(
    userId: string,
    projectId?: string,
  ): Promise<T>;
  getItemsBatch?<T = ItemDetail>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]>;
  getBatchCitationData?<T = unknown>(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<T[]>;
  getTrashInfo?<T = unknown>(userId: string, projectId?: string): Promise<T>;
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
  listDuplicateReviews?<T = unknown>(
    userId: string,
    projectId?: string,
  ): Promise<T[]>;
  previewTypeConversion?<T = unknown>(
    userId: string,
    itemId: string,
    targetType: string,
    projectId?: string,
  ): Promise<T>;
  listNotes?(
    userId: string,
    itemId?: string,
    projectId?: string,
  ): Promise<NoteEntity[]>;
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
  findAttachmentByFileId(
    fileId: string,
    scope?: { userId?: string; projectId?: string },
  ): Promise<{ id: string; itemId: string; metadata?: unknown } | null>;
}

export interface ICatalogWriterPort {
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
  bulkDeleteItems?(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown>;
  updateUserItemState?(
    userId: string,
    itemId: string,
    state: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  batchUpdateItems?(
    userId: string,
    itemIds: string[],
    patch: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  mergeItems(
    tx: Prisma.TransactionClient,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<unknown>;
  convertItemType?(
    userId: string,
    itemId: string,
    targetType: string,
    options?: { expectedVersion?: number; projectId?: string },
  ): Promise<unknown>;
  resolveDuplicateReview?(
    userId: string,
    reviewId: string,
    resolution: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  reconcileExtractedCandidate?(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<unknown>;
  createNote?(userId: string, data: CreateNoteData): Promise<NoteEntity>;
  updateNote?(
    userId: string,
    noteId: string,
    data: Record<string, unknown>,
    projectId?: string,
  ): Promise<NoteEntity>;
  deleteNote?(
    userId: string,
    noteId: string,
    projectId?: string,
  ): Promise<void>;
  addAttachment?(
    userId: string,
    itemId: string,
    data: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  updateAttachment?(
    userId: string,
    attachmentId: string,
    data: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  removeAttachment?(
    userId: string,
    attachmentId: string,
    projectId?: string,
  ): Promise<void>;
  invalidateForWrite?(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
  }): Promise<void>;
  updateAttachmentProcessingStatus(
    attachmentId: string,
    status: string,
    metadataPatch?: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void>;
  updateItemAiMetadata(
    itemId: string,
    aiMetadataPatch: Record<string, unknown>,
    scope?: { userId?: string; projectId?: string },
  ): Promise<void>;
}

export interface ICatalogCollectionPort {
  listCollections(
    userId: string,
    projectId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      itemCount?: number;
      _count?: { collectionItems?: number };
    }>
  >;
  getCollections?(userId: string, projectId?: string): Promise<unknown>;
  createCollection?(
    userId: string,
    data: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  updateCollection?(
    userId: string,
    collectionId: string,
    data: Record<string, unknown>,
    projectId?: string,
  ): Promise<unknown>;
  deleteCollection?(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<unknown>;
  assignItemsToCollection?(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown>;
  removeItemsFromCollection?(
    userId: string,
    collectionId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown>;
  getCollectionItemIds?(
    userId: string,
    collectionId: string,
    projectId?: string,
  ): Promise<string[]>;
}

export interface ICatalogTrashPort {
  listTrash?(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  restoreItems?(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<unknown>;
  emptyTrash?(userId: string, projectId?: string): Promise<unknown>;
  purgeOldTrash?(retentionDays?: number, limit?: number): Promise<unknown>;
}

export interface ICatalogImportExportPort {
  importBibtex?(
    userId: string,
    content: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  importRis?(
    userId: string,
    content: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  exportItems?(
    userId: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  generateCitation?(
    userId: string,
    itemId: string,
    styleId?: string,
    projectId?: string,
  ): Promise<unknown>;
  getAvailableCitationStyles?(): Promise<unknown>;
}

export interface ICatalogFacade
  extends ICatalogReaderPort,
    ICatalogWriterPort,
    ICatalogCollectionPort,
    ICatalogTrashPort,
    ICatalogImportExportPort {}

export interface IItemCacheInvalidator {
  invalidateForWrite(params: {
    userId: string;
    projectId?: string | null;
    itemIds?: string[];
    additionalProjectIds?: Array<string | null | undefined>;
    skipScopeInvalidation?: boolean;
    onlyUserStateOverlay?: boolean;
    preserveContentCaches?: boolean;
  }): Promise<void>;
}

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
  ): Promise<PdfMetadataExtractionResult>;
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

export const SEARCH_FACADE = 'SEARCH_FACADE';

export interface SearchPageTextInput {
  pageIndex: number;
  textContent: string;
  charOffset?: number;
  itemId?: string;
}

interface SearchPageAnchorResult {
  attachmentId: string;
  pageIndex: number;
  snippet: string;
  charOffsetStart: number;
  charOffsetEnd: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

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
      totalCount?: number;
    };
  }>;
  searchPageAnchors?(
    userId: string,
    attachmentId: string,
    term: string,
    pageIndex?: number,
    projectId?: string,
  ): Promise<SearchPageAnchorResult[]>;
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
    pages: SearchPageTextInput[],
  ): Promise<void>;
  removeItemIndex?(itemId: string): Promise<void>;
  removeAttachmentIndex?(attachmentId: string): Promise<void>;
  invalidateScopeCache?(scopeId: string): Promise<void>;
}

// ============================================================================
// 1. UNIT OF WORK PORT
// ============================================================================

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

export type TransactionService = IUnitOfWork;

// ============================================================================
// 2. OUTBOX PORT
// ============================================================================

export interface OutboxEventRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  status: string;
  retryCount: number;
  spaceId?: string;
  actorId?: string | null;
  userId?: string;
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
// 3. IDEMPOTENT CONSUMER PORT
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
