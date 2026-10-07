import { Injectable } from '@nestjs/common';
import { IngestionService } from './services/ingestion.service';
import { DuplicateService } from './services/duplicate.service';
import { QualityService } from './services/quality.service';
import { RetractionService } from './services/retraction.service';

export const INGESTION_FACADE = 'INGESTION_FACADE';

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

  async submitIngestion(envelope: any): Promise<any> {
    return this.ingestionService.submit(envelope);
  }

  async getIngestionStatus(userId: string, runId: string): Promise<any> {
    return this.ingestionService.getRunStatus(userId, runId);
  }

  async findDuplicates(userId: string, projectId?: string): Promise<any[]> {
    return this.duplicateService.detectDuplicates(userId, projectId);
  }

  async getQualityAudit(userId: string, projectId?: string): Promise<any> {
    return this.qualityService.getQualityAudit(userId, projectId);
  }

  async checkRetraction(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any> {
    return this.retractionService.checkItem(userId, itemId, projectId);
  }
}
