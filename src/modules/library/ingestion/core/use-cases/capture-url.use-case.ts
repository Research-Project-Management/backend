import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';

export interface CaptureUrlCommand {
  url: string;
  scope: {
    projectId?: string;
    userId: string;
  };
}

@Injectable()
export class CaptureUrlUseCase {
  private readonly logger = new Logger(CaptureUrlUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(command: CaptureUrlCommand) {
    this.logger.debug(
      `Capturing URL: ${command.url} for user ${command.scope.userId}`,
    );
    return this.ingestionService.captureUrl(command.url, command.scope);
  }
}
