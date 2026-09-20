import {
  AnnotationEntity,
  AnnotationType,
  AnnotationPosition,
} from '../model/annotation.entity';

export const ANNOTATION_REPOSITORY_PORT = Symbol('ANNOTATION_REPOSITORY_PORT');

export interface FindAnnotationsOptions {
  attachmentId?: string;
  itemId?: string;
  type?: AnnotationType;
  isAuthoritative?: boolean;
}

export interface IAnnotationRepositoryPort {
  findById(annotationId: string): Promise<AnnotationEntity | null>;

  findMany(
    userId: string,
    options: FindAnnotationsOptions,
  ): Promise<AnnotationEntity[]>;

  save(entity: AnnotationEntity): Promise<void>;

  delete(annotationId: string, userId: string): Promise<boolean>;

  deleteByAttachment(attachmentId: string): Promise<number>;
}
