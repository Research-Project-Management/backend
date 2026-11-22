import { Injectable } from '@nestjs/common';
import {
  INGESTION_FACADE,
  IIngestionFacade,
  IngestionRunSnapshot,
  ReconcileExtractedCandidatePayload,
} from '@/modules/library/core';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
  DuplicateClusterResult,
  RetractionCheckResult,
} from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionService } from './ingestion.service';
import { DuplicateDetectorService } from './duplicate-detector.service';
import { QualityService, type QualityAuditReport } from './ingestion-verifier.service';
import { RetractionService } from './retraction.service';

export { INGESTION_FACADE };
export type { IIngestionFacade };

/**
 * Public Facade for Ingestion Bounded Context (Supporting Domain).
 * Shields ingestion pipelines, curation/dedup algorithms, and retraction checks.
 */
@Injectable()
export class IngestionFacade implements IIngestionFacade {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly duplicateDetector: DuplicateDetectorService,
    private readonly qualityService: QualityService,
    private readonly retractionService: RetractionService,
  ) {}

  async submitIngestion(
    envelope: IngestionSubmissionEnvelope,
    options?: { enqueue?: boolean },
  ): Promise<IngestionAcceptedResult> {
    return this.ingestionService.submit(envelope, options);
  }

  async getIngestionStatus(
    userId: string,
    runId: string,
  ): Promise<IngestionRunSnapshot> {
    return this.ingestionService.getRunStatus(userId, runId);
  }

  async findDuplicates(
    userId: string,
    projectId?: string,
  ): Promise<DuplicateClusterResult[]> {
    return this.duplicateDetector.detectDuplicates(userId, projectId);
  }

  async getQualityAudit(
    userId: string,
    projectId?: string,
  ): Promise<QualityAuditReport> {
    return this.qualityService.getQualityAudit(userId, projectId);
  }

  async checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<RetractionCheckResult> {
    return this.retractionService.checkItem(userId, itemId, projectId);
  }

  async reResolveMetadata(
    userId: string,
    itemId: string,
    options?: {
      doi?: string;
      arxivId?: string;
      pmid?: string;
      isbn?: string;
      title?: string;
      forceRefresh?: boolean;
      expectedVersion?: number;
    },
    projectId?: string,
  ): Promise<Awaited<ReturnType<IngestionService['reResolveMetadata']>>> {
    return this.ingestionService.reResolveMetadata(
      userId,
      itemId,
      options,
      projectId,
    );
  }

  async reconcileExtractedCandidate(
    payload: ReconcileExtractedCandidatePayload,
  ): Promise<{
    updated: boolean;
    updatedFields: string[];
    rejectedCitedDoi?: string;
  }> {
    return this.ingestionService.reconcileExtractedCandidate(payload);
  }
}
