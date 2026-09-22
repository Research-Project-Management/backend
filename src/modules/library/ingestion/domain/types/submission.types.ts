/**
 * Discriminated union submission contracts for the Ingestion Pipeline.
 * Complies with ADR-0008 & Ingestion Production Architecture.
 */

export type SubmissionKind =
  'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'CONNECTOR';

export type IdentifierType = 'DOI' | 'PMID' | 'ARXIV' | 'ISBN';
export type RecordFormat = 'BIBTEX' | 'RIS' | 'CSL_JSON';

export interface IdentifierSubmissionInput {
  kind: 'IDENTIFIER';
  identifierType: IdentifierType;
  value: string;
}

export interface RecordSubmissionInput {
  kind: 'RECORD';
  format: RecordFormat;
  content: string;
}

export interface UrlSubmissionInput {
  kind: 'URL';
  url: string;
  previewToken?: string;
  filename?: string;
}

export interface FileSubmissionInput {
  kind: 'FILE';
  fileId: string;
  filename?: string;
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
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED_FINAL' | 'FAILED_RETRYABLE' | string;
  existingItemId?: string;
  deduplicated?: boolean;
}
