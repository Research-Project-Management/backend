/**
 * Canonical public contracts for the metadata ingestion pipeline.
 *
 * Self-contained: defines all types, interfaces, tokens, and execution models.
 */

import {
  CreatorCreditInput,
  CreatorInput,
  CreatorType,
  ItemMetadata as CanonicalItemMetadata,
} from '@/modules/library/core';

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
  candidateId: string;
  sourceKind: CandidateSourceKind;
  sourceName: string; // Crossref, OpenAlex, PubMed, BibTeX, RIS, etc.
  sourceProvider?: string;
  sourceRecordId?: string;
  retrievedAt: string;
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
  fetchedAt?: string;
}

export type NormalizedMetadataCandidate = MetadataCandidate;

export interface CandidateValidationError {
  field: string;
  message: string;
  rawValue?: unknown;
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

export type MetadataConflict = MetadataConflictDetail;

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

export interface FieldAssertion {
  field: string;
  value: unknown;
  sourceProvider: string;
  confidenceScore: number;
  isUserOverride: boolean;
  timestamp: string;
}

export interface ConflictReport {
  hasConflicts: boolean;
  conflicts: MetadataConflict[];
}

export interface ReconciledMetadataResult {
  metadata: ItemMetadata;
  assertions: FieldAssertion[];
  candidates: MetadataCandidate[];
  conflictReport: ConflictReport;
  reconciledAt: string;
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
  skipStealth?: boolean;
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
