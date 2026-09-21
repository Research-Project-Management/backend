import { Injectable, Logger } from '@nestjs/common';
import { AnnotationsService } from '../services/annotations.service';
import { UpdateAnnotationData } from '../../domain/types/annotations.types';

export interface UpdateAnnotationCommand {
  userId: string;
  id: string;
  expectedVersion: number;
  data: UpdateAnnotationData;
}

@Injectable()
export class UpdateAnnotationUseCase {
  private readonly logger = new Logger(UpdateAnnotationUseCase.name);

  constructor(private readonly annotationsService: AnnotationsService) {}

  async execute(command: UpdateAnnotationCommand) {
    this.logger.debug(
      `Updating annotation ${command.id} for user ${command.userId}`,
    );
    return this.annotationsService.updateAnnotation(
      command.userId,
      command.id,
      command.expectedVersion,
      command.data,
    );
  }
}
