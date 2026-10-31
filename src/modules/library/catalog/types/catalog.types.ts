import {
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  PRISMA_ITEM_SCALAR_COLUMNS,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
  CreateItemData,
  UpdateItemData,
  NoteEntity,
  CreateNoteData,
} from '@/modules/library/core/types/bibliographic.types';
import type {
  UserId,
  ItemId,
  TagObjectInput,
  TagInput,
} from '@/modules/library/core';

export {
  CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  PRISMA_ITEM_SCALAR_COLUMNS,
  INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  ITEM_COLUMN_METADATA_FIELDS,
  TYPE_SPECIFIC_EXTRA_FIELDS,
};

export type {
  CreateItemData,
  UpdateItemData,
  NoteEntity,
  CreateNoteData,
  UserId,
  ItemId,
  TagObjectInput,
  TagInput,
};

export {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
  BASE_FIELD_MAPPINGS,
  REVERSE_BASE_FIELD_MAPPINGS,
} from '@/modules/library/core/types/schema.constants';

export function parseAccessDate(value?: string): Date | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

// ============================================================================
// 1. COLLECTIONS TYPES
// ============================================================================

export type CollectionDeleteStrategy = 'cascade' | 'move-to-parent' | 'orphan';

export interface CollectionTreeNode {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemCount: number;
  recursiveItemCount?: number;
  children: CollectionTreeNode[];
}

export interface CollectionDetail {
  id: string;
  projectId?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  parentId?: string | null;
  itemsCount: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// 2. TAGS TYPES
// ============================================================================

export interface TagDetail {
  id: string;
  projectId?: string | null;
  name: string;
  color?: string | null;
  type?: string | null;
  shortcut?: number | null;
  userId?: string;
  createdById?: string | null;
  _count?: { itemTags: number };
  createdAt: Date;
  updatedAt: Date;
}

export type TagEntity = TagDetail;

// ============================================================================
// 3. NOTES TYPES
// ============================================================================

export interface UpdateNoteData {
  title?: string;
  contentJson?: Record<string, unknown> | null;
  contentMd?: string;
  tags?: string[];
  expectedVersion?: number;
}

export interface ExtractLiteratureNoteResult {
  success: boolean;
  noteId?: string;
  totalExtracted: number;
  message?: string;
  literatureNote?: NoteEntity;
}

// ============================================================================
// 4. READING STATE TYPES
// ============================================================================

export enum ReadingStatus {
  UNREAD = 'unread',
  READING = 'reading',
  COMPLETED = 'completed',
}

export interface StateEntity {
  id?: string;
  userId: string;
  itemId: string;
  isStarred?: boolean;
  readStatus: ReadingStatus | string;
  rating: number | null;
  currentPage: number | null;
  scrollPosition: unknown;
  lastOpenedAt: Date | null;
  lastReadAt: Date | null;
  updatedAt: Date;
}

export interface StateData {
  isStarred?: boolean;
  readStatus: ReadingStatus;
  rating: number;
  currentPage: number;
  scrollPosition: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt: string | null;
  lastReadAt: string | null;
}

export interface UpsertStateData {
  isStarred?: boolean;
  readStatus?: ReadingStatus;
  rating?: number;
  currentPage?: number;
  scrollPosition?: Record<string, unknown> | Array<unknown> | null;
  lastOpenedAt?: Date | null;
  lastReadAt?: Date | null;
}

export const VALID_READING_TRANSITIONS: Record<
  ReadingStatus,
  readonly ReadingStatus[]
> = {
  [ReadingStatus.UNREAD]: [ReadingStatus.READING, ReadingStatus.COMPLETED],
  [ReadingStatus.READING]: [ReadingStatus.COMPLETED, ReadingStatus.UNREAD],
  [ReadingStatus.COMPLETED]: [ReadingStatus.READING, ReadingStatus.UNREAD],
};

export * from './saved-search.types';
