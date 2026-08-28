/**
 * Canonical public contracts for the metadata ingestion pipeline.
 *
 * Self-contained: defines all types, interfaces, tokens, and execution models.
 * Zero imports from legacy.
 */

// ── Tokens ───────────────────────────────────────────────────────────────────

export const CANONICAL_METADATA_SERVICE = Symbol('CANONICAL_METADATA_SERVICE');
export const CANONICAL_METADATA_PROVIDERS = Symbol(
  'CANONICAL_METADATA_PROVIDERS',
);

// ── Query Types ──────────────────────────────────────────────────────────────

export type QueryType = 'DOI' | 'ARXIV' | 'PMID' | 'ISBN' | 'URL' | 'TITLE';
export type AcademicQueryType = QueryType;

export interface ClassifiedQuery {
  raw: string;
  clean: string;
  type: QueryType;
}

// ── Creator & Provenance Types ────────────────────────────────────────────────

export interface CreatorInput {
  creatorType?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
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

export type ProvenanceMetadata = Provenance;
export type LibraryCreatorInput = CreatorInput;

// ── Item Metadata ────────────────────────────────────────────────────────────

export interface ItemMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  pmcid?: string;
  isbn?: string;
  issn?: string;

  title?: string;
  shortTitle?: string;
  authors?: string[];
  creators?: CreatorInput[];
  editors?: string[];
  year?: number | null;
  publicationDate?: string;
  date?: string;
  journal?: string;
  journalAbbr?: string;
  publicationTitle?: string;
  publisher?: string;
  place?: string;
  volume?: string;
  issue?: string;
  section?: string;
  series?: string;
  seriesTitle?: string;
  pages?: string;
  abstract?: string;
  abstractNote?: string;
  tldr?: string;
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  language?: string;
  url?: string;
  pdfUrl?: string;
  fileUrl?: string;
  filename?: string;
  storageId?: string;
  openAccessPdfUrl?: string;
  itemType?: string;
  citationKey?: string;
  explicitCitationKey?: string;
  extra?: string;
  tags?: string[];
  labels?: string[];
  keywords?: string[];
  notes?: Array<{ content: string; source?: string }>;
  rights?: string;
  license?: string;
  archive?: string;
  archiveLocation?: string;
  callNumber?: string;
  libraryCatalog?: string;

  provenance?: Provenance;
}

export type UnifiedAcademicMetadata = ItemMetadata;

// ── Reconciliation Types ─────────────────────────────────────────────────────

export interface MetadataCandidate {
  id: string;
  sourceProvider: string;
  metadata: ItemMetadata;
  confidenceScore: number;
  rawPayload?: unknown;
  fetchedAt: string;
}

export interface FieldAssertion {
  field: string;
  value: unknown;
  sourceProvider: string;
  confidenceScore: number;
  isUserOverride: boolean;
  timestamp: string;
}

export interface MetadataConflict {
  field: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  variants: {
    sourceProvider: string;
    value: unknown;
    confidenceScore: number;
  }[];
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

// ── Provider Identity & Capabilities ─────────────────────────────────────────

export type ProviderName =
  | 'CrossRef'
  | 'arXiv'
  | 'PubMed'
  | 'OpenLibrary'
  | 'SemanticScholar'
  | 'OpenAlex'
  | 'Unpaywall';

export interface ProviderCapability {
  queryTypes: QueryType[];
  isAuthoritative: boolean;
  timeoutMs: number;
  maxConcurrency: number;
}

// ── Provider Result & Execution Status ───────────────────────────────────────

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

// ── Field-level Provenance ────────────────────────────────────────────────────

export interface FieldProvenance {
  provider: ProviderName | 'UserOverride';
  fetchedAt: string;
  identifier: string;
  confidence: number;
  rawVersion?: string;
}

// ── Canonical Resolution Result ───────────────────────────────────────────────

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

// ── Resolution Request ────────────────────────────────────────────────────────

export interface MetadataRequest {
  query: string;
  workspaceId?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

// ── Canonical Metadata Service Interface ──────────────────────────────────────

export interface CanonicalMetadataResolver {
  resolve(request: MetadataRequest): Promise<ResolvedMetadata | null>;
}

// ── Metadata Provider Interface ───────────────────────────────────────────────

export interface MetadataProvider {
  readonly id: ProviderName;
  readonly capabilities: ProviderCapability;
  supports(queryType: QueryType): boolean;
  resolve(
    request: MetadataRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResult | null>;
}
