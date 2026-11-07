import { CreatorCreditInput, CreatorInput, CreatorType, ItemMetadata as CanonicalItemMetadata } from '@/modules/library/core';
import { BadRequestException } from '@nestjs/common';
import { BaseDomainException } from '@/modules/library/core/errors/domain.exception';

/**
 * Canonical public contracts for the metadata ingestion pipeline.
 *
 * Self-contained: defines all types, interfaces, tokens, and execution models.
 */


export type { CreatorCreditInput, CreatorInput, CreatorType };

// Tokens

export const METADATA_PORT = Symbol('METADATA_PORT');
export const METADATA_PROVIDERS = Symbol('METADATA_PROVIDERS');
export const WEB_FETCH_PORT = Symbol('WEB_FETCH_PORT');

// Query Types

export type QueryType = 'DOI' | 'ARXIV' | 'PMID' | 'ISBN' | 'URL' | 'TITLE';

export interface ClassifiedQuery {
  raw: string;
  clean: string;
  type: QueryType;
}

export interface Provenance {
  provider?: string;
  originProvider?: string;
  resolvedAt: string;
  canonicalId: string;
  canonicalUrl?: string;
  confidenceScore: number;
  rawSnapshotHash?: string;
  isOpenAccess: boolean;
  openAccessPdfUrl?: string;
}

// Item Metadata

export type ItemMetadata = CanonicalItemMetadata;

// Candidate & Reconciliation Types

export type CandidateSourceKind =
  | 'IDENTIFIER'
  | 'RECORD'
  | 'URL'
  | 'FILE'
  | 'PROVIDER'
  | 'CONNECTOR';

export interface FieldEvidence {
  path?: string;
  value?: unknown;
  rawValue?: unknown;
  normalizedValue: unknown;
  confidence: number;
  sourceProvider: string;
  retrievedAt?: string;
  warnings?: string[];
  isUserOverride?: boolean;
}

export interface MetadataCandidate {
  candidateId?: string;
  sourceKind: CandidateSourceKind;
  sourceName?: string; // Crossref, OpenAlex, PubMed, BibTeX, RIS, etc.
  sourceProvider?: string;
  sourceRecordId?: string;
  retrievedAt?: string;
  schemaVersion?: string;
  rawEvidenceRef?: string;
  rawMetadata?: Record<string, unknown>;
  fields: Record<string, FieldEvidence>;
  normalizedMetadata: ItemMetadata;
  confidenceScore?: number;
  overallConfidence?: number;
  id?: string;
  metadata?: ItemMetadata;
  rawPayload?: unknown;
  rawData?: Record<string, unknown>;
  fetchedAt?: string;
}

export interface MetadataConflictDetail {
  field: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  variants: {
    sourceProvider: string;
    value: unknown;
    confidenceScore: number;
  }[];
}

export interface ReconciliationDecision {
  selectedFields: Record<string, FieldEvidence>;
  rejectedFields: Record<string, FieldEvidence[]>;
  conflicts: MetadataConflictDetail[];
  proposedItem: ItemMetadata;
  decidedAt: string;
  policyVersion: string;
}

export interface DuplicateMatchResult {
  matchType: 'EXACT' | 'PROBABLE' | 'NO_MATCH';
  confidence: number;
  targetItemId?: string;
  targetItemTitle?: string;
  matchReason?:
    | 'DOI_EXACT'
    | 'ARXIV_EXACT'
    | 'ISBN_EXACT'
    | 'PMID_EXACT'
    | 'TITLE_FUZZY'
    | 'FILE_HASH'
    | 'NONE';
  evidence?: Record<string, unknown>;
}

// Provider Identity & Capabilities

export type ProviderName =
  | 'CrossRef'
  | 'arXiv'
  | 'PubMed'
  | 'OpenLibrary'
  | 'OpenAlex'
  | 'Unpaywall'
  | 'CORE'
  | 'DBLP'
  | 'SemanticScholar';

export interface ProviderCapability {
  queryTypes: QueryType[];
  isAuthoritative: boolean;
  timeoutMs: number;
  maxConcurrency: number;
}

// Provider Result & Execution Status

export interface ProviderResult {
  provider: ProviderName;
  metadata: Partial<ItemMetadata>;
  confidence: number;
  identifier: string;
  fetchedAt: string;
  rawVersion?: string;
}

export type ProviderExecutionStatus =
  | 'found'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'configuration_error'
  | 'invalid_payload';

export interface ProviderExecutionResult {
  provider: ProviderName;
  status: ProviderExecutionStatus;
  result?: ProviderResult | null;
  error?: string;
  statusCode?: number;
  retryAfterMs?: number;
  durationMs?: number;
}

// Field-level Provenance

export interface FieldProvenance {
  provider: ProviderName | 'UserOverride';
  fetchedAt: string;
  identifier: string;
  confidence: number;
  rawVersion?: string;
}

// Canonical Resolution Result

export interface ResolvedMetadata {
  query: string;
  queryType: QueryType;
  canonicalId: string;
  metadata: ItemMetadata;
  provenance: Record<string, FieldProvenance>;
  cached?: boolean;
  resolvedAt: string;
  policyVersion: number;
}

// Resolution Request

export interface MetadataRequest {
  query: string;
  queryType?: QueryType;
  userId?: string;
  scopeId?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  authorHint?: string;
  yearHint?: number | string;
  includeCitations?: boolean;
  includeReferences?: boolean;
  aggressive?: boolean;
}

// Canonical Metadata Service Interface

export interface MetadataPort {
  resolve(request: MetadataRequest): Promise<ResolvedMetadata | null>;
}

// Metadata Provider Interface

export interface MetadataProvider {
  readonly id: ProviderName;
  readonly capabilities: ProviderCapability;
  supports(input: QueryType | MetadataRequest): boolean;
  resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null>;
}

// Web Fetch Ladder Contracts

export interface WebFetchOptions {
  scopeId?: string;
  userId?: string;
  preferredFilename?: string;
  timeoutMs?: number;
}

export interface MirrorBibliographicMetadata {
  title?: string;
  abstract?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  journal?: string;
  isOpenAccess?: boolean;
  pdfUrl?: string;
  sourceMirror:
    | 'EuropePMC'
    | 'arXiv'
    | 'PubMedCentral'
    | 'OpenMirror'
    | 'CrossRef'
    | 'OpenAlex';
}

export interface WebFetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  isBlocked: boolean;
  wafKind?: string;
  bodyText?: string;
  bodyBuffer?: Buffer;
  isPdf: boolean;
  contentType?: string;
  ladderStepReached: 0 | 1 | 2 | 3 | 4;
  promptUploadPdf?: boolean;
  derivedIdentifier?: {
    doi?: string;
    arxivId?: string;
    pmid?: string;
    pmcid?: string;
  };
  mirrorMetadata?: MirrorBibliographicMetadata;
  headers?: Record<string, string>;
  warnings?: string[];
}

export interface IWebFetchPort {
  fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResponse>;
}

export type IngestionErrorCategory =
  | 'validation_failed'
  | 'unsupported_source'
  | 'metadata_not_found'
  | 'provider_unavailable'
  | 'duplicate_conflict'
  | 'idempotency_conflict'
  | 'storage_failed'
  | 'extraction_failed'
  | 'indexing_failed'
  | 'unauthorized'
  | 'forbidden';

class IngestionException extends BaseDomainException {
  public readonly category: IngestionErrorCategory;

  constructor(
    message: string,
    category: IngestionErrorCategory = 'validation_failed',
  ) {
    super(message);
    this.category = category;
    this.name = this.constructor.name;
  }
}

export class IngestionValidationException extends IngestionException {
  constructor(message: string) {
    super(message, 'validation_failed');
    this.name = 'IngestionValidationException';
  }
}

export interface PipelineErrorClassificationDelegate {
  isNonRetryableError?: (err: unknown) => boolean;
  isRetryableError?: (err: unknown) => boolean;
}

const NON_RETRYABLE_MESSAGE_PATTERN =
  /no valid bibliographic metadata|invalid.*payload|validation failed|bad request|malformed|unsupported format/i;

const RETRYABLE_ERROR_PATTERN =
  /(?:etimedout|econnreset|econnrefused|eai_again|enotfound|epipe|timeout|timed out|rate[\s_-]*limit|too many requests|429|502|503|504|deadlock|serialization failure|connection[\s_-]*(?:lost|reset|refused|closed|error)|temporarily unavailable|service unavailable|bad gateway|gateway timeout|network error|socket hang up|slowdown)/i;

/**
 * Determines whether an ingestion error is permanently non-retryable
 * (e.g., 4xx validation error, empty/malformed bibliographic metadata).
 */
export function isNonRetryableIngestionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if (err instanceof BadRequestException) return true;
  const errObj = err as Record<string, unknown>;
  if (errObj.retryable === false) return true;
  const status = (errObj.status ?? errObj.statusCode) as number | undefined;
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 422
  ) {
    return true;
  }
  const combined = `${String(errObj.code || '')} ${String(errObj.message || '')}`;
  return NON_RETRYABLE_MESSAGE_PATTERN.test(combined);
}

/**
 * Determines whether an ingestion error is transient/retryable (e.g., network
 * timeout, rate limit, 5xx upstream failure, transient DB connection drop).
 */
export function isRetryableIngestionError(
  err: unknown,
  envelope?: { isFinalAttempt?: boolean },
  delegate?: PipelineErrorClassificationDelegate,
): boolean {
  const explicitFinal = envelope?.isFinalAttempt;
  if (explicitFinal === true) return false;
  if (typeof delegate?.isNonRetryableError === 'function') {
    if (delegate.isNonRetryableError(err)) return false;
  } else if (isNonRetryableIngestionError(err)) {
    return false;
  }

  if (explicitFinal === false) return true;
  if (typeof delegate?.isRetryableError === 'function') {
    return delegate.isRetryableError(err);
  }

  if (!err || typeof err !== 'object') return false;
  const errObj = err as Record<string, unknown>;
  if (typeof errObj.retryable === 'boolean') return errObj.retryable;

  const status = (errObj.status ?? errObj.statusCode) as number | undefined;
  if (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status < 600)
  ) {
    return true;
  }

  const combined = `${String(errObj.code || '')} ${String(errObj.message || '')}`;
  return RETRYABLE_ERROR_PATTERN.test(combined);
}

/**
 * Error with structured metadata details from HTTP fetch.
 */
export class ProviderFetchError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly retryAfterMs?: number,
    public readonly isTimeout?: boolean,
    public readonly isParseError?: boolean,
  ) {
    super(message);
    this.name = ProviderFetchError.name;
  }
}

export interface ParsedBibtexEntry {
  citationKey?: string;
  itemType: string;
  title: string;
  shortTitle?: string;
  authors: string[];
  editors?: string[];
  creators?: Array<{
    name?: string;
    fullName?: string;
    firstName?: string;
    lastName?: string;
    creatorType: string;
    fieldMode?: number;
  }>;
  year: number | null;
  publicationDate?: string;
  journal?: string;
  journalAbbr?: string;
  publisher?: string;
  university?: string;
  institution?: string;
  thesisType?: string;
  reportNumber?: string;
  reportType?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  eventPlace?: string;
  place?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  numPages?: string;
  numberOfVolumes?: string;
  seriesNumber?: string;
  chapter?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  url?: string;
  accessedAt?: string;
  abstract?: string;
  series?: string;
  edition?: string;
  keywords?: string[];
  tags?: string[];
  notes?: string[];
  language?: string;
  rights?: string;
  fileUrl?: string;
  extra?: string;
  arxivId?: string;
  seeAlso?: string[];
  relations?: Record<string, string | string[]>;
  [key: string]: unknown;
}

export type BibtexItem = ParsedBibtexEntry;

export interface RisItem extends ItemMetadata {
  pmid?: string;
  pmcid?: string;
  shortTitle?: string;
  journalAbbr?: string;
  accessedAt?: string | Date | null;
  university?: string;
  institution?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  conferenceName?: string;
  reportNumber?: string;
  patentNumber?: string;
  thesisType?: string;
}

export interface ScrapedCreator {
  firstName?: string;
  lastName: string;
  fullName?: string;
  creatorType?: string;
  fieldMode?: number;
}

export interface ScrapedUrlResult {
  url: string;
  isPdf: boolean;
  fileBuffer?: Buffer;
  filename?: string;
  fileId?: string;
  title?: string;
  shortTitle?: string;
  authors?: string[];
  creators?: ScrapedCreator[];
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;
  year?: number;
  publicationDate?: string;
  publicationTitle?: string;
  journal?: string;
  journalAbbr?: string;
  publisher?: string;
  abstract?: string;
  keywords?: string[];
  pdfUrl?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  language?: string;
  publisherPlace?: string;
  place?: string;
  conferenceName?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  series?: string;
  edition?: string;
  rights?: string;
  institution?: string;
  university?: string;
  thesisType?: string;
  reportNumber?: string;
  itemType?: string;
  confidence: number;
  isBlocked?: boolean;
  wafKind?: string;
  promptUploadPdf?: boolean;
  ladderStepReached?: number;
}

export interface MetaEntry {
  key: string;
  value: string;
  alias: boolean;
}

export type FallbackMeta = {
  title?: string;
  authors?: string[];
  creators?: Array<{
    firstName?: string;
    lastName: string;
    fullName?: string;
    creatorType?: string;
    fieldMode?: number;
  }>;
  date?: string;
  publicationTitle?: string;
  publisher?: string;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  issn?: string;
  isbn?: string;
  abstract?: string;
  keywords?: string[];
  language?: string;
  itemType?: string;
};

export const URL_METADATA_SCRAPER_PORT = Symbol('URL_METADATA_SCRAPER_PORT');

export interface IUrlMetadataScraperPort {
  scrape(
    rawUrl: string,
    options?: {
      scopeId?: string;
      userId?: string;
      preferredFilename?: string;
    },
  ): Promise<ScrapedUrlResult>;
  extractSlugMetadata(rawUrl: string): { title?: string; filename: string };
}

export interface PdfFingerprint {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  firstAuthorSurname?: string;
  year?: number;
  firstPageText?: string;
}

export type IngestionVerificationStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'NEEDS_REVIEW'
  | 'BLOCKED'
  | 'FAILED';

export interface VerificationFieldProvenance {
  source: string;
  confidence: number;
  verified: boolean;
}

export interface VerificationResult {
  verificationScore: number;
  isVerified: boolean;
  status: IngestionVerificationStatus;
  matchedSignals: string[];
  missingFields: string[];
  fieldProvenance: Record<string, VerificationFieldProvenance>;
  warnings: string[];
  isDisambiguationMismatch?: boolean;
}

export const INGESTION_VERIFIER_PORT = Symbol('INGESTION_VERIFIER_PORT');

export interface IIngestionVerifierPort {
  extractFingerprint(metadata: ItemMetadata, firstPageText?: string): PdfFingerprint;
  verifyWebCandidate(
    fingerprint: PdfFingerprint,
    candidate: ItemMetadata,
    sourceName?: string,
  ): VerificationResult;
  evaluateLocalResult(
    metadata: ItemMetadata,
    engineUsed?: string,
    qualityScore?: number,
  ): VerificationResult;
}


