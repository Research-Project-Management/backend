import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';

export interface GetIngestionProgressQuery {
  userId: string;
  runId: string;
}

@Injectable()
export class GetIngestionProgressUseCase {
  private readonly logger = new Logger(GetIngestionProgressUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(query: GetIngestionProgressQuery) {
    this.logger.debug(`Retrieving real-time progress for run ${query.runId}`);
    return this.ingestionService.getRunProgress(query.userId, query.runId);
  }
}
