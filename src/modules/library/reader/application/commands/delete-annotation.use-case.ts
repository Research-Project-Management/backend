import { Injectable, Logger } from '@nestjs/common';
import { AnnotationsService } from '../services/annotations.service';

export interface DeleteAnnotationCommand {
  userId: string;
  id: string;
  expectedVersion?: number;
}

@Injectable()
export class DeleteAnnotationUseCase {
  private readonly logger = new Logger(DeleteAnnotationUseCase.name);

  constructor(private readonly annotationsService: AnnotationsService) {}

  async execute(command: DeleteAnnotationCommand): Promise<boolean> {
    this.logger.debug(
      `Deleting annotation ${command.id} for user ${command.userId}`,
    );
    return this.annotationsService.deleteAnnotation(
      command.userId,
      command.id,
      command.expectedVersion,
    );
  }
}
