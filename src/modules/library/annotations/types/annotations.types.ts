import {
  Prisma,
  Annotation as PrismaAnnotation,
  AnnotationType,
} from '@prisma/client';

export type AnnotationEntity = PrismaAnnotation;
export { AnnotationType };

export type RectCoords = [number, number, number, number];

export interface CreateAnnotationData {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: unknown;
  authorId: string;
}

export interface UpdateAnnotationData {
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: unknown;
}
