import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  ANNOTATION_REPOSITORY_PORT,
  IAnnotationRepositoryPort,
} from '../../domain/ports/annotation-repository.port';
import { AnnotationsService } from '../services/annotations.service';

export interface GetAnnotationQuery {
  userId: string;
  id: string;
}

@Injectable()
export class GetAnnotationUseCase {
  private readonly logger = new Logger(GetAnnotationUseCase.name);

  constructor(
    @Optional()
    @Inject(ANNOTATION_REPOSITORY_PORT)
    private readonly annotationRepo?: IAnnotationRepositoryPort,
    @Optional()
    private readonly annotationsService?: AnnotationsService,
  ) {}

  async execute(query: GetAnnotationQuery): Promise<any>;
  async execute(userId: string, id: string): Promise<any>;
  async execute(first: GetAnnotationQuery | string, second?: string): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const id = typeof first === 'string' ? second! : first.id;

    if (this.annotationsService) {
      return this.annotationsService.getAnnotation(userId, id);
    }

    if (this.annotationRepo) {
      return this.annotationRepo.findById(id);
    }

    throw new Error(
      'Neither AnnotationsService nor IAnnotationRepositoryPort is available in GetAnnotationUseCase',
    );
  }
}
