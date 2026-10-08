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
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'beginsWith'
  | 'endsWith'
  | 'isGreaterThan'
  | 'isLessThan'
  | 'isBetween'
  | 'isInTheLast'
  | 'isPresent'
  | 'isAbsent';

export interface SavedSearchScopeOptions {
  searchSubcollections?: boolean;
  showOnlyTopLevel?: boolean;
  includeParentsAndChildren?: boolean;
}

export interface SavedSearchCondition {
  field: SavedSearchField;
  operator: SavedSearchOperator;
  value?:
    string | number | boolean | (string | number)[] | Record<string, unknown>;
}

export interface SavedSearchConditionGroup {
  conjunction: 'AND' | 'OR';
  conditions: (SavedSearchCondition | SavedSearchConditionGroup)[];
  scopeOptions?: SavedSearchScopeOptions;
}

export function isConditionGroup(
  node: SavedSearchCondition | SavedSearchConditionGroup,
): node is SavedSearchConditionGroup {
  return 'conjunction' in node && Array.isArray(node.conditions);
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
    | 'updatedAt';
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
  contributors?: SavedSearchContributor[];
  identifiers?: SavedSearchIdentifier[];
  attachments?: SavedSearchAttachment[];
  itemTags?: SavedSearchTag[];
  collectionItems?: SavedSearchCollection[];
}
