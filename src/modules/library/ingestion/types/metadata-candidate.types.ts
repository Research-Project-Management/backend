import { ItemMetadata } from '../metadata/types/metadata.types';

export interface FieldEvidence {
  path: string;
  value: unknown;
  normalizedValue: unknown;
  confidence: number;
  sourceProvider: string;
  retrievedAt: string;
  warnings?: string[];
}

export interface MetadataCandidate {
  candidateId: string;
  sourceKind:
    'IDENTIFIER' | 'RECORD' | 'URL' | 'FILE' | 'PROVIDER' | 'CONNECTOR';
  sourceName: string; // Crossref, OpenAlex, PubMed, BibTeX, RIS, etc.
  sourceRecordId?: string;
  retrievedAt: string;
  schemaVersion: string;
  rawEvidenceRef?: string;
  fields: Record<string, FieldEvidence>;
  normalizedMetadata: ItemMetadata;
  confidenceScore: number;
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
    | 'ISBN_EXACT'
    | 'PMID_EXACT'
    | 'TITLE_FUZZY'
    | 'FILE_HASH'
    | 'NONE';
  evidence?: Record<string, unknown>;
}
