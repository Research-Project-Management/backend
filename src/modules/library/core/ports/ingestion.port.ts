import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
} from '@/modules/library/ingestion/types/submission.types';
import { IngestionRunSnapshot } from '@/modules/library/ingestion/types/ingestion.types';
import { DuplicateClusterResult } from '@/modules/library/ingestion/types/curation.types';
import { RetractionCheckResult } from '@/modules/library/ingestion/types/retraction.types';
import { QualityAuditReport } from '@/modules/library/ingestion/services/quality.service';

export const INGESTION_FACADE = 'INGESTION_FACADE';

export interface ReResolveMetadataOptions {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  isbn?: string;
  title?: string;
  forceRefresh?: boolean;
  expectedVersion?: number;
  projectId?: string;
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
}
