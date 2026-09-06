import { AnnotationType } from '@prisma/client';

export interface AnnotationDetail {
  id: string;
  attachmentId: string;
  type: AnnotationType;
  pageIndex: number;
  color?: string | null;
  quoteText?: string | null;
  comment?: string | null;
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

export interface CreateAnnotationInput {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
}

export interface UpdateAnnotationInput {
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: Record<string, unknown> | Array<unknown> | null;
}
