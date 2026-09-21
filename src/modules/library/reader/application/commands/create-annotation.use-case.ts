import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  ANNOTATION_REPOSITORY_PORT,
  IAnnotationRepositoryPort,
} from '../../domain/ports/annotation-repository.port';
import { AnnotationEntity } from '../../domain/model/annotation.entity';
import { AnnotationsService } from '../services/annotations.service';
import { CreateAnnotationData } from '../../domain/types/annotations.types';

export interface CreateAnnotationCommand {
  userId: string;
  data: CreateAnnotationData;
}

@Injectable()
export class CreateAnnotationUseCase {
  private readonly logger = new Logger(CreateAnnotationUseCase.name);

  constructor(
    @Optional()
    @Inject(ANNOTATION_REPOSITORY_PORT)
    private readonly annotationRepo?: IAnnotationRepositoryPort,
    @Optional()
    private readonly annotationsService?: AnnotationsService,
  ) {}

  async execute(command: CreateAnnotationCommand): Promise<any>;
  async execute(userId: string, data: CreateAnnotationData): Promise<any>;
  async execute(first: CreateAnnotationCommand | string, second?: CreateAnnotationData): Promise<any> {
    const userId = typeof first === 'string' ? first : first.userId;
    const data = typeof first === 'string' ? second! : first.data;

    if (this.annotationsService) {
      return this.annotationsService.createAnnotation(userId, data);
    }

    if (this.annotationRepo) {
      this.logger.debug(`Creating annotation via domain port for user ${userId}`);
      const entity = AnnotationEntity.create({
        attachmentId: data.attachmentId,
        itemId: data.attachmentId,
        userId,
        type: (data.type as any) ?? 'highlight',
        color: data.color,
        text: data.quoteText,
        comment: data.comment,
        pageIndex: data.pageIndex,
      });
      await this.annotationRepo.save(entity);
      return entity;
    }

    throw new Error('Neither AnnotationsService nor IAnnotationRepositoryPort is available in CreateAnnotationUseCase');
  }
}
