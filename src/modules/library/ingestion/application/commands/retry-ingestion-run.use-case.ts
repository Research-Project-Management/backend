import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';

export interface RetryIngestionRunCommand {
  userId: string;
  runId: string;
}

@Injectable()
export class RetryIngestionRunUseCase {
  private readonly logger = new Logger(RetryIngestionRunUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(command: RetryIngestionRunCommand) {
    this.logger.debug(
      `Retrying ingestion run ${command.runId} for user ${command.userId}`,
    );
    return this.ingestionService.retryRun(command.userId, command.runId);
  }
}
