import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';

export interface GetIngestionStatusQuery {
  userId: string;
  runId: string;
}

@Injectable()
export class GetIngestionStatusUseCase {
  private readonly logger = new Logger(GetIngestionStatusUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(query: GetIngestionStatusQuery) {
    this.logger.debug(`Retrieving status for run ${query.runId}`);
    return this.ingestionService.getRunStatus(query.userId, query.runId);
  }
}
