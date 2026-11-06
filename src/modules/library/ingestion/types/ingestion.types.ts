import {
  CreatorCreditInput,
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  ItemCreator,
} from '@/modules/library/core/types/bibliographic.types';
import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import { libraryConfig } from '@/modules/library/core/config/library.config';
import { MetadataCandidate, ItemMetadata } from './metadata.types';

export type IngestionStageName =
  | 'IDENTIFY'
  | 'NORMALIZE'
  | 'ENRICH'
  | 'RECONCILE'
  | 'MATCH'
  | 'COMMIT'
  | 'ENRICH_EXISTING'
  | 'RESOLVE';

export type FeedFormat = 'rss2' | 'rss1-rdf' | 'atom';

export interface ParsedFeedEntry {
  id: string;
  title: string;
  url?: string;
  pdfUrl?: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  primaryCategory?: string;
  authors: string[];
  creators: ItemCreator[];
  abstract?: string;
  publicationTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publicationDate?: string;
  year?: number | null;
  keywords: string[];
  rights?: string;
  itemType: 'journalArticle' | 'preprint' | 'webpage';
  isRead?: boolean;
  isSaved?: boolean;
  savedItemId?: string | null;
}

export interface ParsedFeed {
  format: FeedFormat;
  feedTitle?: string;
  feedUrl?: string;
  siteUrl?: string;
  description?: string;
  updatedAt?: string;
  entries: ParsedFeedEntry[];
}

export type LibraryItemSource =
  | 'WEB_CAPTURE'
  | 'PDF_UPLOAD'
  | 'IDENTIFIER_IMPORT'
  | 'BIBTEX_IMPORT'
  | 'MANUAL'
  | 'CONNECTOR'
  | (string & {});

export interface CommitStageOptions {
  collectionIds?: string[];
  tagIds?: string[];
  userId?: string;
  source?: LibraryItemSource;
  fileId?: string;
  filename?: string;
  skipPreMatch?: boolean;
}

export const LIBRARY_INGESTION_QUEUE_STANDARD =
  libraryConfig().ingestion.standardQueue;

export const LIBRARY_INGESTION_QUEUE = LIBRARY_INGESTION_QUEUE_STANDARD;

export const LIBRARY_INGESTION_JOB = 'process_ingestion_run';

export interface IngestionStage {
  id: string;
  ingestionRunId: string;
  stageName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string | null;
  outputSnapshot?: unknown;
  leaseToken?: string | null;
  leaseExpiresAt?: Date | null;
  executedAt: Date;
}

export interface IngestionReviewCase {
  id: string;
  userId?: string | null;
  projectId?: string | null;
  ingestionRunId: string;
  targetItemId?: string | null;
  reason: string;
  evidence?: unknown;
  options?: unknown;
  assignedToId?: string | null;
  status: string;
  resolution?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
}

export type IngestionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'CANCELLED'
  | 'STALLED'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export type IngestionCommand =
  | {
      source: 'doi';
      projectId?: string;
      scopeId?: string;
      doi: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'arxiv';
      projectId?: string;
      scopeId?: string;
      arxivId: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'pmid';
      projectId?: string;
      scopeId?: string;
      pmid: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'isbn';
      projectId?: string;
      scopeId?: string;
      isbn: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    }
  | {
      source: 'url';
      projectId?: string;
      scopeId?: string;
      url: string;
      previewToken?: string;
      userId?: string;
      collectionId?: string;
      overrides?: {
        title?: string;
        abstract?: string;
        doi?: string;
        year?: number;
        publicationTitle?: string;
        itemType?: string;
        creators?: CreatorCreditInput[];
        tags?: string[];
        url?: string;
      };
      idempotencyKey?: string;
    }
  | {
      source: 'bibtex';
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      source: 'ris';
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      source: 'csl_json';
      projectId?: string;
      scopeId?: string;
      content: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      source: 'pdf';
      projectId?: string;
      scopeId?: string;
      fileId?: string;
      filename?: string;
      userId?: string;
      collectionId?: string;
      overrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  | {
      source: 'zotero';
      projectId?: string;
      scopeId?: string;
      connectionId?: string;
      externalItemKey?: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
    }
  | {
      source: string;
      projectId?: string;
      scopeId?: string;
      content?: string;
      doi?: string;
      arxivId?: string;
      pmid?: string;
      isbn?: string;
      url?: string;
      fileId?: string;
      filename?: string;
      connectionId?: string;
      externalItemKey?: string;
      userId?: string;
      collectionId?: string;
      idempotencyKey?: string;
      overrides?: Record<string, unknown>;
    };

export interface IngestionResult {
  runId: string;
  status: 'completed' | 'processing' | 'failed';
  itemId?: string;
  attachmentIds: string[];
  deduplicated: boolean;
  item?: unknown;
  errorCategory?: string;
  errorMessage?: string;
}

export interface IngestionRunSnapshot {
  id: string;
  projectId: string;
  scopeId?: string;
  sourceType: string;
  status: IngestionStatus;
  currentStage?: string | null;
  totalItems: number;
  processedItems: number;
  failedItems: number;
  startedAt: Date;
  completedAt?: Date | null;
  lastError?: string | null;
  itemId?: string | null;
  item?: Record<string, unknown> | null;
  stages: IngestionStage[];
  reviews?: IngestionReviewCase[];
  errors: unknown[];
}

// ============================================================================
// Submission Contracts
// ============================================================================

export type SubmissionKind =
  | 'IDENTIFIER'
  | 'RECORD'
  | 'URL'
  | 'FILE'
  | 'CONNECTOR';

export type IdentifierType = 'DOI' | 'PMID' | 'ARXIV' | 'ISBN';
export type RecordFormat =
  | 'BIBTEX'
  | 'RIS'
  | 'CSL_JSON'
  | 'ENDNOTE_XML'
  | 'MODS'
  | 'ZOTERO_RDF'
  | 'MEDLINE'
  | 'CSV'
  | 'REFER';

export interface IdentifierSubmissionInput {
  kind: 'IDENTIFIER';
  identifierType: IdentifierType;
  value: string;
}

export interface RecordSubmissionInput {
  kind: 'RECORD';
  format: RecordFormat;
  content?: string;
  isOffloaded?: boolean;
  fileId?: string;
  storageKey?: string;
  byteSize?: number;
  uncompressedSize?: number;
}

export interface UrlSubmissionInput {
  kind: 'URL';
  url: string;
  previewToken?: string;
  filename?: string;
  size?: number;
}

export interface FileSubmissionInput {
  kind: 'FILE';
  fileId: string;
  filename?: string;
  size?: number;
}

export interface ConnectorSubmissionInput {
  kind: 'CONNECTOR';
  connectionId: string;
  externalObjectId: string;
  externalVersion: string;
}

export type SubmissionPayload =
  | IdentifierSubmissionInput
  | RecordSubmissionInput
  | UrlSubmissionInput
  | FileSubmissionInput
  | ConnectorSubmissionInput;

export interface IngestionSubmissionEnvelope {
  projectId?: string;
  scopeId?: string;
  userId?: string;
  idempotencyKey?: string;
  payload: SubmissionPayload;
  collectionIds?: string[];
  tagIds?: string[];
  overrides?: Record<string, unknown>;
  contractVersion?: string;
  isFinalAttempt?: boolean;
}

export interface IngestionAcceptedResult {
  runId: string;
  statusUrl: string;
  acceptedAt: string;
  requestHash: string;
  status:
    | 'PENDING'
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED_FINAL'
    | 'FAILED_RETRYABLE'
    | (string & {});
  existingItemId?: string;
  deduplicated?: boolean;
}

// ============================================================================
// Workflow Stage Contracts
// ============================================================================

export interface IWorkflowStage<TInput, TOutput> {
  readonly stageName: IngestionStageName;
  execute(input: TInput): Promise<TOutput>;
}

export interface IdentifyStageInput {
  runId: string;
  payload: IngestionSubmissionEnvelope['payload'];
  scopeId?: string;
  userId?: string;
  projectId?: string;
}

export interface ResolveStageInput {
  scopeId: string;
  candidates: MetadataCandidate[];
}

export interface ResolveMatchInput {
  scope: { userId?: string; projectId?: string | null } | string;
  proposedItem?: ItemMetadata;
}

export interface CommitStageInput {
  scopeId: string | { userId?: string; projectId?: string | null };
  item: ItemMetadata;
  options?: CommitStageOptions;
}

// ============================================================================
// Curation & Deduplication Contracts
// ============================================================================

export const ALLOWED_MERGE_METADATA_FIELDS = new Set([
  ...CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  ...SCHEMA_V42_DATA.distinctFieldKeys,
  'authors',
  'creators',
  'contributors',
  'editors',
  'extra',
  'extraFields',
  'tags',
  'identifiers',
]);

export interface DuplicateClusterItem {
  id: string;
  title: string;
  itemType?: string;
  type?: string;
  doi?: string;
  isbn?: string | null;
  issn?: string | null;
  pmid?: string | null;
  arxivId?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  abstract?: string | null;
  abstractNote?: string | null;
  url?: string | null;
  authors?: string[];
  creators?: unknown[];
  citationKey?: string;
  collectionId?: string | null;
  collections?: unknown[];
  tags?: unknown[];
  attachments?: unknown[];
  notes?: unknown[];
  extra?: string | null;
  extraFields?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export class DuplicateClusterResult {
  clusterId!: string;
  matchReason!: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | (string & {});
  confidence!: number;
  recommendedMasterId?: string;
  items!: DuplicateClusterItem[];
}

export interface PrismaMergeAuditTrail {
  masterItemId: string;
  mergedDuplicateIds: string[];
  matchReasons: string[];
  preservedCitationKeys: string[];
  consolidatedAttachments: number;
  consolidatedNotes: number;
  consolidatedTags: number;
  consolidatedCollections: number;
  backfilledFields: string[];
  timestamp: string;
}

// ============================================================================
// Retraction Contracts
// ============================================================================

export type RetractionNature =
  | 'retraction'
  | 'Retraction'
  | 'expression_of_concern'
  | 'Expression of concern'
  | 'correction'
  | 'Correction'
  | 'manual';

export type RetractionSource =
  | 'crossref'
  | 'openalex'
  | 'retraction_watch'
  | 'manual';

export interface RetractionDetails {
  nature: RetractionNature;
  reason?: string;
  noticeUrl?: string;
  date?: string;
  source: RetractionSource;
}

export type RetractionLookupResult =
  | { status: 'retracted'; details: RetractionDetails }
  | { status: 'clean' }
  | { status: 'unknown' };

export interface RetractionCheckResult {
  itemId: string;
  isRetracted: boolean;
  /** `unknown` = could not be verified; stored status was left untouched. */
  status?: 'retracted' | 'clean' | 'unknown';
  nature?: RetractionNature;
  details?: RetractionDetails;
  checkedAt: Date;
}

export interface RetractionStats {
  totalItems: number;
  checkedItems: number;
  retractedCount: number;
  expressionsOfConcernCount: number;
  manualCount: number;
}

export interface IngestionSubmissionInput {
  kind: SubmissionKind;
  source?: string;
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  bibtex?: string;
  ris?: string;
  identifierType?: IdentifierType;
  value?: string;
  identifierValue?: string;
  format?: RecordFormat;
  recordFormat?: RecordFormat;
  content?: string;
  rawRecord?: string;
  url?: string;
  previewToken?: string;
  fileId?: string;
  filename?: string;
  connectionId?: string;
  externalObjectId?: string;
  externalItemKey?: string;
  externalVersion?: string;
  payload?: unknown;
  allowDuplicates?: boolean;
  autoExtract?: boolean;
  enableOcr?: boolean;
  silent?: boolean;
  idempotencyKey?: string;
  collectionId?: string;
  collectionIds?: string[];
  tagIds?: string[];
  overrides?: Record<string, unknown>;
  contractVersion?: string;
  projectId?: string;
}

export interface UnifiedIngestionInput {
  source:
    | 'doi'
    | 'arxiv'
    | 'pmid'
    | 'isbn'
    | 'url'
    | 'bibtex'
    | 'ris'
    | 'csl_json'
    | 'endnote_xml'
    | 'mods'
    | 'zotero_rdf'
    | 'medline'
    | 'csv'
    | 'pdf'
    | 'zotero';
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  url?: string;
  previewToken?: string;
  overrides?: Record<string, unknown>;
  content?: string;
  bibtex?: string;
  ris?: string;
  fileId?: string;
  filename?: string;
  connectionId?: string;
  externalItemKey?: string;
  payload?: unknown;
  silent?: boolean;
  collectionId?: string;
  idempotencyKey?: string;
  projectId?: string;
}

export const INGESTION_QUEUE_PORT = Symbol('INGESTION_QUEUE_PORT');

export interface IIngestionQueuePort {
  enqueue(
    runId: string,
    projectId: string,
    envelope: IngestionSubmissionEnvelope,
  ): Promise<boolean>;
}

export const RETRACTION_DATABASE_PORT = Symbol('RETRACTION_DATABASE_PORT');

export interface IRetractionDatabasePort {
  checkRetraction(
    doi?: string | null,
    pmid?: string | null,
  ): Promise<RetractionDetails | false | null>;
  saveRetraction(
    doi: string,
    details: RetractionDetails,
    pmid?: string | null,
    title?: string | null,
  ): Promise<void>;
  saveClean(doi: string, pmid?: string | null): Promise<void>;
}

export const RETRACTION_SERVICE_PORT = Symbol('RETRACTION_SERVICE_PORT');

export interface IRetractionCheckPort {
  checkItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<RetractionCheckResult>;
}
