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

export interface LibraryNote {
  id: string;
  itemId?: string | null;
  title: string;
  content: string;
  tags?: string[];
  version: number;
  authorId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractedPdfMetadata {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  title?: string;
  authors?: string[];
  year?: number;
  abstract?: string;
}
