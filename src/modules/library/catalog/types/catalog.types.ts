import { CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS, PRISMA_ITEM_SCALAR_COLUMNS, INTERNAL_SYSTEM_AND_TELEMETRY_KEYS, ITEM_COLUMN_METADATA_FIELDS, TYPE_SPECIFIC_EXTRA_FIELDS, CreateItemData, UpdateItemData, NoteEntity, CreateNoteData } from '@/modules/library/core/types/bibliographic.types';
import type { UserId, ItemId, TagObjectInput, TagInput } from '@/modules/library/core';
import { IsString, IsOptional, IsBoolean, IsIn, IsObject, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

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

/**
 * Runtime enum-like object (required by `ParseEnumPipe`) + derived union type.
 * A bare `type` alias cannot be used as a value, so the controller could not compile.
 */
export const CollectionDeleteStrategy = {
  CASCADE: 'cascade',
  MOVE_TO_PARENT: 'move-to-parent',
  ORPHAN: 'orphan',
} as const;
export type CollectionDeleteStrategy =
  (typeof CollectionDeleteStrategy)[keyof typeof CollectionDeleteStrategy];

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
  lastActiveAttachmentId?: string | null;
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
  lastActiveAttachmentId?: string | null;
  lastOpenedAt: string | null;
  lastReadAt: string | null;
}

export interface UpsertStateData {
  attachmentId?: string;
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

export interface SavedSearchContributor {
  id?: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  creatorType?: string;
  orderIndex?: number;
}

export interface SavedSearchIdentifier {
  id?: string;
  type: string;
  value: string;
  canonicalUri?: string | null;
}

export interface SavedSearchAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number | bigint;
  url?: string;
}

export interface SavedSearchTag {
  tag: {
    id: string;
    name: string;
    color?: string | null;
  };
}

export interface SavedSearchCollection {
  collection: {
    id: string;
    name: string;
    color?: string | null;
  };
}

export type SavedSearchField =
  | 'anyField'
  | 'title'
  | 'abstract'
  | 'creator'
  | 'year'
  | 'itemType'
  | 'tag'
  | 'collection'
  | 'readStatus'
  | 'rating'
  | 'doi'
  | 'isbn'
  | 'issn'
  | 'hasAttachment'
  | 'dateAdded'
  | 'dateModified'
  | 'publicationTitle'
  | 'publisher'
  | 'place'
  | 'volume'
  | 'issue'
  | 'pages'
  | 'series'
  | 'url'
  | 'attachmentContent'
  | 'attachmentFilename'
  | 'noteContent'
  | 'callNumber'
  | 'archive'
  | 'archiveLocation'
  | 'shortTitle'
  | 'rights'
  | 'extra'
  | (string & {});

export type SavedSearchOperator =
  | 'is'
  | 'equals'
  | 'isNot'
  | 'is_not'
  | 'not_equals'
  | 'contains'
  | 'doesNotContain'
  | 'does_not_contain'
  | 'beginsWith'
  | 'begins_with'
  | 'endsWith'
  | 'ends_with'
  | 'isGreaterThan'
  | 'greater_than'
  | 'gt'
  | 'isLessThan'
  | 'less_than'
  | 'lt'
  | 'isBetween'
  | 'between'
  | 'isInTheLast'
  | 'in_the_last'
  | 'isPresent'
  | 'is_present'
  | 'isAbsent'
  | 'is_absent';

export interface SavedSearchScopeOptions {
  searchSubcollections?: boolean;
  showOnlyTopLevel?: boolean;
  includeParentsAndChildren?: boolean;
  includeParentAndChild?: boolean;
}

export interface SavedSearchCondition {
  field: SavedSearchField;
  operator: SavedSearchOperator;
  value?:
    string | number | boolean | (string | number)[] | Record<string, unknown>;
}

export interface SavedSearchConditionGroup {
  conjunction?: 'AND' | 'OR';
  operator?: 'AND' | 'OR';
  matchMode?: 'all' | 'any' | 'AND' | 'OR';
  conditions: (SavedSearchCondition | SavedSearchConditionGroup)[];
  scopeOptions?: SavedSearchScopeOptions;
}

export function isConditionGroup(
  node: SavedSearchCondition | SavedSearchConditionGroup,
): node is SavedSearchConditionGroup {
  return (
    typeof node === 'object' &&
    node !== null &&
    ('conjunction' in node || 'matchMode' in node || 'operator' in node) &&
    'conditions' in node &&
    Array.isArray(node.conditions)
  );
}

export interface ExecuteSavedSearchOptions {
  limit?: number;
  page?: number;
  cursor?: string;
  sortBy?:
    | 'dateAdded'
    | 'createdAt'
    | 'year'
    | 'title'
    | 'creator'
    | 'authors'
    | 'firstAuthor'
    | 'publication'
    | 'publicationTitle'
    | 'citationKey'
    | 'deletedAt'
    | 'dateDeleted'
    | 'updatedAt'
    | 'dateModified';
  sortOrder?: 'asc' | 'desc';
}

const SAVED_SEARCH_SORT_BY_VALUES = [
  'dateAdded',
  'createdAt',
  'year',
  'title',
  'creator',
  'authors',
  'publication',
  'publicationTitle',
  'citationKey',
  'deletedAt',
  'dateDeleted',
  'updatedAt',
] as const;

export type SavedSearchSortBy = (typeof SAVED_SEARCH_SORT_BY_VALUES)[number];

export class CreateSavedSearchDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsObject()
  conditions!: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetScope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  scope?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

export class UpdateSavedSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @IsObject()
  conditions?: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsIn(['AND', 'OR'])
  conjunction?: 'AND' | 'OR';

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  targetScope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  scope?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expectedVersion?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

export class PreviewSavedSearchDto {
  @IsObject()
  conditions!: SavedSearchConditionGroup;

  @IsOptional()
  @IsObject()
  scopeOptions?: SavedSearchScopeOptions;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  sortBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;
}

export class ExecuteSavedSearchQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @IsOptional()
  @IsIn(SAVED_SEARCH_SORT_BY_VALUES)
  sortBy?: SavedSearchSortBy;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  projectId?: string;
}
