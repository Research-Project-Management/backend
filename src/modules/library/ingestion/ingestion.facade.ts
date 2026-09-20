import { Injectable, Optional } from '@nestjs/common';
import { IngestionService } from './application/services/ingestion.service';
import { DuplicateService } from './application/services/duplicate.service';
import { QualityService } from './application/services/quality.service';
import { RetractionService } from './application/services/retraction.service';

export const INGESTION_FACADE = 'INGESTION_FACADE';
export const PROCESSING_FACADE = INGESTION_FACADE;

export interface IIngestionFacade {
  submitIngestion(envelope: any): Promise<any>;
  getIngestionStatus(userId: string, runId: string): Promise<any>;
  findDuplicates(userId: string, projectId?: string): Promise<any[]>;
  getQualityAudit(userId: string, projectId?: string): Promise<any>;
  checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any>;
}

export type IProcessingFacade = IIngestionFacade;

/**
 * Public Facade for Ingestion Bounded Context (Supporting Domain).
 * Shields ingestion pipelines, curation/dedup algorithms, and retraction checks.
 */
@Injectable()
export class IngestionFacade implements IIngestionFacade {
  constructor(
    @Optional() private readonly ingestionService?: IngestionService,
    @Optional() private readonly duplicateService?: DuplicateService,
    @Optional() private readonly qualityService?: QualityService,
    @Optional() private readonly retractionService?: RetractionService,
  ) {}

  async submitIngestion(envelope: any): Promise<any> {
    if (!this.ingestionService) return null;
    return this.ingestionService.submit(envelope);
  }

  async getIngestionStatus(userId: string, runId: string): Promise<any> {
    if (!this.ingestionService) return null;
    return this.ingestionService.getRunStatus(userId, runId);
  }

  async findDuplicates(userId: string, projectId?: string): Promise<any[]> {
    if (!this.duplicateService) return [];
    return this.duplicateService.detectDuplicates(userId, projectId);
  }

  async getQualityAudit(userId: string, projectId?: string): Promise<any> {
    if (!this.qualityService) return null;
    return this.qualityService.getQualityAudit(userId, projectId);
  }

  async checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any> {
    if (!this.retractionService) return null;
    return this.retractionService.checkItem(userId, itemId, projectId);
  }
}

export { IngestionFacade as ProcessingFacade };
