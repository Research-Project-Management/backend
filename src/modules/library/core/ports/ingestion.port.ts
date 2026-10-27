import type {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  IngestionRunSnapshot,
  DuplicateClusterResult,
  RetractionCheckResult,
  QualityAuditReport,
} from '../types/ingestion.types';

export const INGESTION_FACADE = 'INGESTION_FACADE';

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
  attachmentId: string;
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
