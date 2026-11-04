import type { Prisma } from '@prisma/client';
import type { TransactionHelpers } from '../ports';

/**
 * Canonical Branded ID & Nominal Types for Flux Library.
 * Implements Matt Pocock's Total TypeScript Nominal Branding Pattern.
 * Prevents accidental cross-assignment of UUIDs across distinct entity domains.
 */
declare const _brand: unique symbol;

/**
 * Nominal Branding Utility.
 * Attaches a compile-time unique brand tag to a base type with zero runtime cost.
 */
export type Brand<T, TBrand extends string> = T & { readonly [_brand]: TBrand };

export type ItemId = Brand<string, 'ItemId'>;
export type AttachmentId = Brand<string, 'AttachmentId'>;
export type TagId = Brand<string, 'TagId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;

/**
 * Core Item-Type Schema & Registry Types for Flux Library.
 * Defines the canonical bibliographic item-type registry owned by the Library domain.
 */

/**
 * All 38 authoritative Zotero/CSL Item Types.
 * Matt Pocock Discriminated Union pattern for canonical bibliographic items.
 */
export type CanonicalItemType =
  | 'journalArticle'
  | 'preprint'
  | 'conferencePaper'
  | 'thesis'
  | 'report'
  | 'dataset'
  | 'presentation'
  | 'standard'
  | 'book'
  | 'bookSection'
  | 'manuscript'
  | 'dictionaryEntry'
  | 'encyclopediaArticle'
  | 'magazineArticle'
  | 'newspaperArticle'
  | 'bill'
  | 'case'
  | 'hearing'
  | 'statute'
  | 'patent'
  | 'audioRecording'
  | 'videoRecording'
  | 'film'
  | 'radioBroadcast'
  | 'tvBroadcast'
  | 'podcast'
  | 'artwork'
  | 'map'
  | 'blogPost'
  | 'webpage'
  | 'forumPost'
  | 'letter'
  | 'interview'
  | 'document'
  | 'email'
  | 'instantMessage'
  | 'computerProgram'
  | 'annotation'
  | 'attachment'
  | 'note';

export interface ItemFieldDefinition {
  key: string;
  field?: string;
  label: string;
  baseField?: string;
  order?: number;
  category?:
    'core' | 'venue' | 'publication' | 'identifiers' | 'archive' | 'extra';
  type?: 'text' | 'textarea' | 'date' | 'number' | 'url';
  placeholder?: string;
  mono?: boolean;
}

export interface CreatorTypeDefinition {
  creatorType: string;
  label: string;
  primary?: boolean;
}

export interface ItemTypeDefinition {
  itemType: CanonicalItemType;
  label: string;
  category:
    | 'academic'
    | 'books'
    | 'articles'
    | 'legal'
    | 'media'
    | 'documents'
    | 'special';
  fields: ItemFieldDefinition[];
  creatorTypes: CreatorTypeDefinition[];
  primaryCreatorType: string;
  isBibliographic: boolean;
  isSpecial: boolean;
  source: string;
  schemaVersion: number;
}

export interface SchemaRegistrySnapshot {
  version: number;
  registryVersion?: number;
  source: string;
  itemTypes: Record<string, ItemTypeDefinition>;
  baseFieldMappings: Record<string, Record<string, string>>; // [itemType][baseField] -> type-specific field
  reverseBaseFieldMappings: Record<string, Record<string, string>>; // [itemType][typeSpecificField] -> baseField
  creatorRoles: Record<string, string>;
  distinctFieldKeys: string[];
  cslTypeMap: Record<string, string>; // itemType -> cslType
  cslCreatorMap: Record<string, string>; // zoteroCreatorType -> cslName
  cslFieldMap: Record<string, string>; // zoteroField -> cslField
}

export interface CreatorHarmonizationChange {
  index: number;
  originalName: string;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'normalized-to-primary' | 'fallback-to-contributor';
}

export interface SchemaValidationResult {
  valid: boolean;
  itemType: string;
  sanitizedItem: Record<string, unknown>;
  warnings: string[];
  demotedToExtra: Record<string, unknown>;
  creatorChanges: CreatorHarmonizationChange[];
}

export interface QualityAuditCandidateItem {
  id: string;
  title: string;
  doi: string | null;
  abstract: string | null;
  year: number | null;
  contributors: Array<{ id: string }>;
  publicationTitle: string | null;
}

export interface DuplicateCandidateItem {
  id: string;
  title: string;
  itemType?: string | null;
  type?: string | null;
  doi: string | null;
  arxivId?: string | null;
  isbn: string | null;
  issn: string | null;
  pmid: string | null;
  citationKey: string | null;
  year: number | null;
  metadata?: Record<string, unknown> | null;
  contributors: Array<{
    fullName: string;
    firstName: string | null;
    lastName: string | null;
    orderIndex: number;
  }>;
}

export interface NoteEntity {
  id: string;
  projectId?: string | null;
  itemId?: string | null;
  title: string;
  contentJson?: unknown;
  contentMd?: string | null;
  tags?: string[];
  createdById?: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateNoteData {
  projectId?: string;
  itemId?: string | null;
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  createdById?: string;
}

export interface FieldMappingChange {
  fromField: string;
  toField: string;
  value: unknown;
  rule: 'direct' | 'base-semantic' | 'special-rule';
}

export interface DroppedField {
  field: string;
  label: string;
  value: unknown;
}

export interface CreatorRoleChange {
  creator: Record<string, unknown>;
  fromRole: string;
  toRole: string;
  reason: 'preserved' | 'primary-fallback' | 'secondary-fallback';
}

export interface TypeConversionPreview {
  sourceType: string;
  targetType: string;
  preservedFields: string[];
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  newAvailableFields: string[];
  schemaUnsupportedFields?: string[];
  schemaUnsupportedFieldLabels?: string[];
  creatorChanges: CreatorRoleChange[];
  projectedItem: Record<string, unknown>;
  unmappedRetained: Record<string, unknown>;
  hasLoss: boolean;
}

export interface ConvertTypeOptions {
  expectedVersion?: number;
  retainUnmappedInExtra?: boolean;
}

/** Transaction context passed to write methods for composing operations within a parent transaction. */
export interface ItemTransactionContext<TTx = Prisma.TransactionClient> {
  tx: TTx;
  helpers: TransactionHelpers;
}

export type SubmissionKind =
  'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'CONNECTOR';

export type IdentifierType = 'DOI' | 'PMID' | 'ARXIV' | 'ISBN';
export type RecordFormat =
  'BIBTEX' | 'RIS' | 'CSL_JSON' | 'ENDNOTE_XML' | 'MODS' | 'REFER';

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
  | 'failed'
  | 'stalled';

export interface IngestionStageSnapshot {
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

export interface IngestionCandidateSnapshot {
  id: string;
  ingestionRunId: string;
  sourceProvider: string;
  sourceRecordId?: string | null;
  confidenceScore: number;
  metadataPayload: unknown;
  rawEvidenceRef?: string | null;
  fetchedAt: Date;
}

export interface IngestionDecisionSnapshot {
  id: string;
  ingestionRunId: string;
  decisionType: string;
  decisionReason: string;
  proposedItem: unknown;
  fieldDecisions?: unknown;
  duplicateMatch?: unknown;
  decidedAt: Date;
}

export interface IngestionReviewCaseSnapshot {
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
  stages: IngestionStageSnapshot[];
  candidates?: IngestionCandidateSnapshot[];
  decisions?: IngestionDecisionSnapshot[];
  reviews?: IngestionReviewCaseSnapshot[];
  errors: unknown[];
}

export interface DuplicateClusterItemSnapshot {
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

export interface DuplicateClusterResult {
  clusterId: string;
  matchReason: 'EXACT_DOI' | 'FUZZY_TITLE_YEAR_AUTHOR' | (string & {});
  confidence: number;
  recommendedMasterId?: string;
  items: DuplicateClusterItemSnapshot[];
}

export type RetractionNature =
  | 'retraction'
  | 'Retraction'
  | 'expression_of_concern'
  | 'Expression of concern'
  | 'correction'
  | 'Correction'
  | 'manual';

export type RetractionSource =
  'crossref' | 'openalex' | 'retraction_watch' | 'manual';

export interface RetractionDetails {
  nature: RetractionNature;
  reason?: string;
  noticeUrl?: string;
  date?: string;
  source: RetractionSource;
}

export interface RetractionCheckResult {
  itemId: string;
  isRetracted: boolean;
  status?: 'retracted' | 'clean' | 'unknown';
  nature?: RetractionNature;
  details?: RetractionDetails;
  checkedAt: Date;
}

export interface QualityAuditReport {
  totalItems: number;
  averageQualityScore: number;
  healthReport: {
    missingDoi: number;
    missingAbstract: number;
    missingYear: number;
  };
}
