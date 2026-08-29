import { AnnotationType } from '@prisma/client';

export class CreateAnnotationDto {
  type?: AnnotationType;
  pageIndex!: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
}

export class UpdateAnnotationDto {
  color?: string;
  quoteText?: string;
  comment?: string;
  rectCoords?: any;
  expectedVersion?: number;
}
