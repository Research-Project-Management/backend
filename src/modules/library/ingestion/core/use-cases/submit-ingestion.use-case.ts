import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';

export interface SubmitIngestionCommand {
  projectId?: string;
  userId: string;
  idempotencyKey?: string;
  payload: any;
  collectionIds?: string[];
  tagIds?: string[];
  overrides?: any;
  contractVersion?: string;
}

@Injectable()
export class SubmitIngestionUseCase {
  private readonly logger = new Logger(SubmitIngestionUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(command: SubmitIngestionCommand) {
    this.logger.debug(
      `Submitting ingestion for user ${command.userId} (kind: ${command.payload?.kind})`,
    );
    return this.ingestionService.submit(command);
  }
}
