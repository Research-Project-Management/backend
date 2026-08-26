export type AnnotationType = 'highlight' | 'underline' | 'note' | 'box';

export interface RectBounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  itemId?: string;
  paperId?: string;
  attachmentId?: string;
  type: AnnotationType;
  pageNumber: number;
  color: string;
  quote?: string;
  comment?: string;
  rect?: RectBounds;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedLiteratureNote {
  title: string;
  content: string;
  annotationCount: number;
  createdAt: string;
  annotationId?: string;
  quote?: string;
  comment?: string;
  pageNumber?: number;
  color?: string;
  paperTitle?: string;
  citationKey?: string;
}
