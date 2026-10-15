export const AnnotationType = {
  highlight: 'highlight',
  underline: 'underline',
  strike: 'strike',
  note: 'note',
  rect: 'rect',
  text: 'text',
  image: 'image',
  ink: 'ink',
} as const;

export type AnnotationType =
  (typeof AnnotationType)[keyof typeof AnnotationType];

export const ANNOTATION_COLORS = {
  yellow: '#ffd400',
  red: '#ff6666',
  green: '#5fb236',
  blue: '#2ea8e5',
  purple: '#a28ae5',
  magenta: '#e56eee',
  orange: '#f19837',
  gray: '#aaaaaa',
} as const;

export type AnnotationColor =
  (typeof ANNOTATION_COLORS)[keyof typeof ANNOTATION_COLORS];

export interface AnnotationEntity {
  id: string;
  attachmentId: string;
  type: AnnotationType;
  pageIndex: number;
  annotationSortIndex?: string | null;
  color: string;
  quoteText?: string | null;
  comment?: string | null;
  tags: string[];
  rectCoords?: unknown;
  authorId: string;
  version: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AnnotationResult =
  | { success: true; data: AnnotationEntity }
  | {
      success: false;
      code: 'NOT_FOUND' | 'VERSION_MISMATCH' | 'FORBIDDEN';
      message: string;
    };

export type RectCoords = [number, number, number, number];

export interface CreateAnnotationData {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  y?: number;
  x?: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  authorId: string;
}

export interface UpdateAnnotationData {
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
}

export interface UpsertAnnotationItem {
  id?: string;
  type?: AnnotationType;
  pageIndex: number;
  y?: number;
  x?: number;
  color?: string;
  quoteText?: string;
  comment?: string;
  tags?: string[];
  rectCoords?: unknown;
  expectedVersion?: number;
}

export interface BatchAnnotationsData {
  upserts: UpsertAnnotationItem[];
  deletes: string[];
}

export interface BatchAnnotationsResult {
  created: AnnotationEntity[];
  updated: AnnotationEntity[];
  deleted: string[];
}

export const ANNOTATION_REPOSITORY_PORT = Symbol('ANNOTATION_REPOSITORY_PORT');
export interface IAnnotationRepositoryPort {
  findByAttachment(
    attachmentId: string,
    pageIndex?: number,
    type?: AnnotationType,
    tx?: unknown,
  ): Promise<AnnotationEntity[]>;

  findById(id: string, tx?: unknown): Promise<AnnotationEntity | null>;

  create(data: CreateAnnotationData, tx?: unknown): Promise<AnnotationEntity>;

  update(
    id: string,
    data: UpdateAnnotationData,
    tx?: unknown,
  ): Promise<AnnotationEntity>;

  softDelete(
    id: string,
    authorId: string,
    expectedVersion?: number,
    tx?: unknown,
  ): Promise<AnnotationEntity>;

  batchUpsert(
    attachmentId: string,
    authorId: string,
    data: BatchAnnotationsData,
    tx?: unknown,
  ): Promise<BatchAnnotationsResult>;

  deleteManyByItemId(itemId: string, tx?: unknown): Promise<number>;

  softDeleteByAttachmentIds(
    attachmentIds: string[],
    tx?: unknown,
  ): Promise<number>;
}
