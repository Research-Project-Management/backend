import {
  Contributor,
  Identifier,
  Attachment,
  ItemTag,
  Tag,
  CollectionItem,
  Collection,
} from '@prisma/client';

export type SavedSearchField =
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
  | 'hasAttachment'
  | 'dateAdded'
  | 'publicationTitle';

export type SavedSearchOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'beginsWith'
  | 'endsWith'
  | 'isGreaterThan'
  | 'isLessThan'
  | 'isBetween'
  | 'isPresent'
  | 'isAbsent';

export interface SavedSearchCondition {
  field: SavedSearchField;
  operator: SavedSearchOperator;
  value?: string | number | boolean | (string | number)[];
}

export interface SavedSearchConditionGroup {
  conjunction: 'AND' | 'OR';
  conditions: (SavedSearchCondition | SavedSearchConditionGroup)[];
}

export function isConditionGroup(
  node: SavedSearchCondition | SavedSearchConditionGroup,
): node is SavedSearchConditionGroup {
  return 'conjunction' in node && Array.isArray(node.conditions);
}

export interface ExecuteSavedSearchOptions {
  limit?: number;
  cursor?: string;
  sortBy?: 'dateAdded' | 'year' | 'title' | 'creator';
  sortOrder?: 'asc' | 'desc';
}

export interface SavedSearchItemResult {
  id: string;
  title: string;
  year?: number | null;
  itemType?: string | null;
  publicationTitle?: string | null;
  doi?: string | null;
  citationKey?: string | null;
  createdAt: Date;
  updatedAt: Date;
  contributors?: Contributor[];
  identifiers?: Identifier[];
  attachments?: Attachment[];
  itemTags?: (ItemTag & { tag: Tag })[];
  collectionItems?: (CollectionItem & { collection: Collection })[];
}
