import { Injectable, Logger } from '@nestjs/common';
import { AnnotationsService } from '../services/annotations.service';
import {
  BatchAnnotationsData,
  BatchAnnotationsResult,
} from '../../domain/types/annotations.types';

export interface BatchUpsertAnnotationsCommand {
  userId: string;
  attachmentId: string;
  data: BatchAnnotationsData;
}

@Injectable()
export class BatchUpsertAnnotationsUseCase {
  private readonly logger = new Logger(BatchUpsertAnnotationsUseCase.name);

  constructor(private readonly annotationsService: AnnotationsService) {}

  async execute(
    command: BatchUpsertAnnotationsCommand,
  ): Promise<BatchAnnotationsResult> {
    this.logger.debug(
      `Batch upserting annotations for attachment ${command.attachmentId} (user: ${command.userId})`,
    );
    return this.annotationsService.batchUpsertAnnotations(
      command.userId,
      command.attachmentId,
      command.data,
    );
  }
}
