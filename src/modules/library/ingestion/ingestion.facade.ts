import { Injectable } from '@nestjs/common';
import { IngestionService } from './services/ingestion.service';
import { DuplicateDetectorService } from './services/duplicate-detector.service';
import { QualityService, QualityAuditReport } from './services/quality.service';
import { RetractionService } from './services/retraction.service';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
} from './types/submission.types';
import { IngestionRunSnapshot } from './types/ingestion.types';
import { DuplicateClusterResult } from './types/curation.types';
import { RetractionCheckResult } from './types/retraction.types';

import {
  INGESTION_FACADE,
  IIngestionFacade,
} from '@/modules/library/core/ports/ingestion.port';
export { INGESTION_FACADE };
export type { IIngestionFacade };

/**
 * Public Facade for Ingestion Bounded Context (Supporting Domain).
 * Shields ingestion pipelines, curation/dedup algorithms, and retraction checks.
 */
@Injectable()
export class IngestionFacade {
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
}
