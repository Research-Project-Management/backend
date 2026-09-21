import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  ANNOTATION_REPOSITORY_PORT,
  IAnnotationRepositoryPort,
} from '../../domain/ports/annotation-repository.port';
import { AnnotationsService } from '../services/annotations.service';
import { AnnotationType } from '../../domain/types/annotations.types';

export interface ListAnnotationsQuery {
  userId: string;
  attachmentId: string;
  pageIndex?: number;
  type?: AnnotationType;
}

@Injectable()
export class ListAnnotationsUseCase {
  private readonly logger = new Logger(ListAnnotationsUseCase.name);

  constructor(
    @Optional()
    @Inject(ANNOTATION_REPOSITORY_PORT)
    private readonly annotationRepo?: IAnnotationRepositoryPort,
    @Optional()
    private readonly annotationsService?: AnnotationsService,
  ) {}

  async execute(query: ListAnnotationsQuery): Promise<any>;
  async execute(
    userId: string,
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
  ): Promise<any>;
  async execute(
    first: ListAnnotationsQuery | string,
    second?: string,
    third?: number,
    fourth?: AnnotationType,
  ): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const attachmentId = typeof first === 'string' ? second! : first.attachmentId;
    const pageIndex = typeof first === 'string' ? third : first.pageIndex;
    const type = typeof first === 'string' ? fourth : first.type;

    if (this.annotationsService) {
      return this.annotationsService.getAnnotationsByAttachment(
        userId,
        attachmentId,
        pageIndex,
        type,
      );
    }

    if (this.annotationRepo) {
      return this.annotationRepo.findMany(userId, {
        attachmentId,
        type: type as any,
      });
    }

    throw new Error(
      'Neither AnnotationsService nor IAnnotationRepositoryPort is available in ListAnnotationsUseCase',
    );
  }
}
