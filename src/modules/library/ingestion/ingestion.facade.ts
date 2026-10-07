import { Injectable } from '@nestjs/common';
import { IngestionService } from './services/ingestion.service';
import { DuplicateService } from './services/duplicate.service';
import { QualityService, QualityAuditReport } from './services/quality.service';
import { RetractionService } from './services/retraction.service';
import {
  IngestionSubmissionEnvelope,
  IngestionAcceptedResult,
} from './types/submission.types';
import { IngestionRunSnapshot } from './types/ingestion.types';
import { DuplicateClusterResult } from './types/curation.types';
import { RetractionCheckResult } from './types/retraction.types';

export const INGESTION_FACADE = 'INGESTION_FACADE';

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
}

/**
 * Public Facade for Ingestion Bounded Context (Supporting Domain).
 * Shields ingestion pipelines, curation/dedup algorithms, and retraction checks.
 */
@Injectable()
export class IngestionFacade implements IIngestionFacade {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly duplicateService: DuplicateService,
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
    return this.duplicateService.detectDuplicates(userId, projectId);
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
}
