/**
 * Discriminated union submission contracts for the Ingestion Pipeline.
 */

export type SubmissionKind =
  'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'CONNECTOR';

export type IdentifierType = 'DOI' | 'PMID' | 'ARXIV' | 'ISBN';
export type RecordFormat =
  | 'BIBTEX' // BibTeX (.bib)
  | 'RIS' // Research Information Systems (.ris)
  | 'CSL_JSON' // Citation Style Language JSON (.json)
  | 'ENDNOTE_XML' // EndNote XML (.xml) — via Zotero Translation Server
  | 'MODS' // Metadata Object Description Schema (.xml) — via Zotero Translation Server
  | 'REFER'; // BibIX / Refer format (.refer) — via Zotero Translation Server

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
