export const AnnotationType = {
  highlight: 'highlight',
  underline: 'underline',
  strike: 'strike',
  note: 'note',
  rect: 'rect',
  text: 'text',
  image: 'image',
} as const;

export type AnnotationType =
  (typeof AnnotationType)[keyof typeof AnnotationType];

// ─── Zotero-compatible annotation colors ────────────────────────────────────
// Const object pattern (Matt Pocock) — avoids TypeScript enum pitfalls

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

// ─── AnnotationEntity — Pure Domain Entity ──────────────────────────────────
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

// ─── Service result — discriminated union ───────────────────────────────────

export type AnnotationResult =
  | { success: true; data: AnnotationEntity }
  | {
      success: false;
      code: 'NOT_FOUND' | 'VERSION_MISMATCH' | 'FORBIDDEN';
      message: string;
    };

// ─── Data transfer types ─────────────────────────────────────────────────────

export type RectCoords = [number, number, number, number];

export interface CreateAnnotationData {
  attachmentId: string;
  type?: AnnotationType;
  pageIndex: number;
  /** Y coordinate in [0,1] page-relative — used to build annotationSortIndex */
  y?: number;
  /** X coordinate in [0,1] page-relative — used to build annotationSortIndex */
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

// ─── Batch types ──────────────────────────────────────────────────────────────

export interface UpsertAnnotationItem {
  /** If present → update existing annotation */
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
  /** Required when id is present (optimistic lock) */
  expectedVersion?: number;
}

export interface BatchAnnotationsData {
  /** max 200 */
  upserts: UpsertAnnotationItem[];
  /** annotation IDs to soft-delete */
  deletes: string[];
}

export interface BatchAnnotationsResult {
  created: AnnotationEntity[];
  updated: AnnotationEntity[];
  deleted: string[];
}
