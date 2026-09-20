import { Injectable, Logger } from '@nestjs/common';
import { IngestionService } from '../services/ingestion.service';
import { ConfirmCapturedUrlDto } from '../dtos/capture-url.dto';

export interface ConfirmCapturedUrlCommand {
  scopeId: string;
  userId: string;
  dto: ConfirmCapturedUrlDto;
}

@Injectable()
export class ConfirmCapturedUrlUseCase {
  private readonly logger = new Logger(ConfirmCapturedUrlUseCase.name);

  constructor(private readonly ingestionService: IngestionService) {}

  async execute(command: ConfirmCapturedUrlCommand) {
    this.logger.debug(
      `Confirming captured URL token ${command.dto.previewToken} for user ${command.userId}`,
    );
    return this.ingestionService.confirmCapturedUrl(
      command.scopeId,
      command.userId,
      command.dto,
    );
  }
}
