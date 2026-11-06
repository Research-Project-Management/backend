import { CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS, PRISMA_ITEM_SCALAR_COLUMNS, INTERNAL_SYSTEM_AND_TELEMETRY_KEYS, ITEM_COLUMN_METADATA_FIELDS, TYPE_SPECIFIC_EXTRA_FIELDS, CreateItemData, UpdateItemData, NoteEntity, CreateNoteData } from '@/modules/library/core/types/bibliographic.types';
import type { UserId, ItemId, TagObjectInput, TagInput } from '@/modules/library/core';

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
// 2. NOTES TYPES
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
// 3. READING STATE TYPES
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

export const SAVED_SEARCH_SORT_BY_VALUES = [
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

export interface AssignItemsToCollectionInput {
  itemIds?: string[];
}

export interface CreateSavedSearchInput {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  conditions: SavedSearchConditionGroup;
  scopeOptions?: SavedSearchScopeOptions;
  conjunction?: 'AND' | 'OR';
  sortBy?: SavedSearchSortBy;
  sortOrder?: 'asc' | 'desc';
  isPinned?: boolean;
  projectId?: string;
  targetScope?: string;
  scope?: string;
  expectedVersion?: number;
  version?: number;
}

import {
  FIELD_ALIASES,
} from '@/modules/library/core/types/schema.constants';

export const SYSTEM_AND_TELEMETRY_KEYS = new Set([
  ...INTERNAL_SYSTEM_AND_TELEMETRY_KEYS,
  'id', 'projectId', 'userId', 'createdById', 'uploadedById', 'createdAt',
  'updatedAt', 'deletedAt', 'version', 'expectedVersion', 'isDeleted',
  'silent', 'provenance', 'fieldProvenance', 'lockedFields', 'ingestionStatus',
  'verificationScore', 'isVerified', 'matchedSignals', 'missingFields',
  'isSelfSufficient', 'qualityScore', 'engineUsed', 'disambiguationWarning',
  'rejectedCitedDoi', 'promptUploadPdf', 'sourceProvider', 'source', 'sources',
  'originProvider', 'canonicalId', 'canonicalUrl', 'resolvedAt', 'warnings',
  'dismissedDuplicateIds', 'mergedFromIds', 'crossrefEnriched', 'isRetracted',
  'retractionNature', 'retractionDetails', 'retractionCheckedAt', 'isMyPublication',
  'publicationConfirmedAt', 'userStates', 'states', 'readStatus', 'rating',
  'lastReadAt', 'isStarred', 'demotedToExtra', 'demotedExtraLines', '__demotedExtraLines',
]);

export const PRIVILEGED_INTERNAL_KEYS = new Set([
  '__isSystemUpdate',
  '__updateSource',
]);

export const UNIVERSAL_FIELDS = new Set([
  ...SYSTEM_AND_TELEMETRY_KEYS,
  ...CANONICAL_BIBLIOGRAPHIC_COLUMN_AND_ALIAS_KEYS,
  ...Object.keys(FIELD_ALIASES),
  ...Object.values(FIELD_ALIASES),
  'creators', 'authors', 'author', 'editors', 'contributors', 'metadata',
  'relations', 'seeAlso', 'tags', 'labels', 'itemTags', 'keywords',
  'keywordsList', 'collectionId', 'collectionIds', 'collections',
  'collectionItems', 'notes', 'notesList', 'fileUrl', 'fileId', 'filename',
  'mimeType', 'size', 'primaryFile', 'attachments', 'identifiers',
  'extraFields', 'URL', 'numberOfPages', 'numPages', 'journalRef',
  'primaryCategory', 'categories',
]);

export interface UpdateSavedSearchInput {
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  conditions?: SavedSearchConditionGroup;
  scopeOptions?: SavedSearchScopeOptions;
  conjunction?: 'AND' | 'OR';
  sortBy?: SavedSearchSortBy;
  sortOrder?: 'asc' | 'desc';
  isPinned?: boolean;
  targetScope?: string;
  scope?: string;
  expectedVersion?: number;
  version?: number;
}
