/**
 * Strict Runtime Validators for External Zotero Web API Responses.
 * Validates untrusted payload from `unknown` without type assertion bypasses.
 */

export interface ValidatedZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  title?: string;
  abstractNote?: string;
  creators?: Array<{
    creatorType?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
  }>;
  date?: string;
  DOI?: string;
  doi?: string;
  publicationTitle?: string;
  journalAbbreviation?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  series?: string;
  seriesTitle?: string;
  seriesText?: string;
  seriesNumber?: string;
  publisher?: string;
  place?: string;
  ISSN?: string;
  ISBN?: string;
  url?: string;
  archive?: string;
  archiveLocation?: string;
  libraryCatalog?: string;
  callNumber?: string;
  rights?: string;
  extra?: string;
  tags?: Array<{ tag: string; type?: number }>;
  collections?: string[];
  relations?: Record<string, unknown>;
  dateAdded?: string;
  dateModified?: string;
  parentItem?: string;
  filename?: string;
  contentType?: string;
  charset?: string;
  md5?: string;
  mtime?: number;
  note?: string;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  [key: string]: unknown;
}

export interface ValidatedZoteroItem {
  key: string;
  version: number;
  library?: {
    type: string;
    id: number | string;
    name?: string;
  };
  data: ValidatedZoteroItemData;
  meta?: Record<string, unknown>;
}

export interface ValidatedZoteroCollectionData {
  key: string;
  version: number;
  name: string;
  parentCollection?: string | false;
  relations?: Record<string, unknown>;
}

export interface ValidatedZoteroCollection {
  key: string;
  version: number;
  library?: {
    type: string;
    id: number | string;
    name?: string;
  };
  data: ValidatedZoteroCollectionData;
  meta?: Record<string, unknown>;
}

export interface ValidatedZoteroDeletedResponse {
  items: string[];
  collections: string[];
  searches: string[];
}

export class ZoteroResponseValidationError extends Error {
  constructor(
    message: string,
    public readonly rawData?: unknown,
  ) {
    super(`Zotero Response Validation Failed: ${message}`);
    this.name = 'ZoteroResponseValidationError';
  }
}

/**
 * Validates that an unknown value is a record object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a single Zotero item from unknown JSON payload.
 */
export function validateZoteroItem(raw: unknown): ValidatedZoteroItem {
  if (!isRecord(raw)) {
    throw new ZoteroResponseValidationError(
      'Item payload must be a non-null object',
      raw,
    );
  }

  const key = typeof raw.key === 'string' ? raw.key.trim() : undefined;
  if (!key) {
    throw new ZoteroResponseValidationError(
      'Missing or invalid "key" property in item',
      raw,
    );
  }

  const version =
    typeof raw.version === 'number'
      ? raw.version
      : typeof raw.version === 'string'
        ? parseInt(raw.version, 10)
        : 0;

  if (!isRecord(raw.data)) {
    throw new ZoteroResponseValidationError(
      `Missing or invalid "data" property in item ${key}`,
      raw,
    );
  }

  const itemDataRaw = raw.data;
  const itemType =
    typeof itemDataRaw.itemType === 'string'
      ? itemDataRaw.itemType
      : 'journalArticle';

  const validatedData: ValidatedZoteroItemData = {
    key: typeof itemDataRaw.key === 'string' ? itemDataRaw.key : key,
    version:
      typeof itemDataRaw.version === 'number' ? itemDataRaw.version : version,
    itemType,
    title: typeof itemDataRaw.title === 'string' ? itemDataRaw.title : '',
    abstractNote:
      typeof itemDataRaw.abstractNote === 'string'
        ? itemDataRaw.abstractNote
        : undefined,
    date: typeof itemDataRaw.date === 'string' ? itemDataRaw.date : undefined,
    DOI:
      typeof itemDataRaw.DOI === 'string'
        ? itemDataRaw.DOI
        : typeof itemDataRaw.doi === 'string'
          ? itemDataRaw.doi
          : undefined,
    publicationTitle:
      typeof itemDataRaw.publicationTitle === 'string'
        ? itemDataRaw.publicationTitle
        : undefined,
    journalAbbreviation:
      typeof itemDataRaw.journalAbbreviation === 'string'
        ? itemDataRaw.journalAbbreviation
        : undefined,
    volume:
      typeof itemDataRaw.volume === 'string' ? itemDataRaw.volume : undefined,
    issue:
      typeof itemDataRaw.issue === 'string' ? itemDataRaw.issue : undefined,
    pages:
      typeof itemDataRaw.pages === 'string' ? itemDataRaw.pages : undefined,
    publisher:
      typeof itemDataRaw.publisher === 'string'
        ? itemDataRaw.publisher
        : undefined,
    url: typeof itemDataRaw.url === 'string' ? itemDataRaw.url : undefined,
    extra:
      typeof itemDataRaw.extra === 'string' ? itemDataRaw.extra : undefined,
    parentItem:
      typeof itemDataRaw.parentItem === 'string'
        ? itemDataRaw.parentItem
        : undefined,
    filename:
      typeof itemDataRaw.filename === 'string'
        ? itemDataRaw.filename
        : undefined,
    contentType:
      typeof itemDataRaw.contentType === 'string'
        ? itemDataRaw.contentType
        : undefined,
    note: typeof itemDataRaw.note === 'string' ? itemDataRaw.note : undefined,
    annotationType:
      typeof itemDataRaw.annotationType === 'string'
        ? itemDataRaw.annotationType
        : undefined,
    annotationText:
      typeof itemDataRaw.annotationText === 'string'
        ? itemDataRaw.annotationText
        : undefined,
    annotationComment:
      typeof itemDataRaw.annotationComment === 'string'
        ? itemDataRaw.annotationComment
        : undefined,
    annotationColor:
      typeof itemDataRaw.annotationColor === 'string'
        ? itemDataRaw.annotationColor
        : undefined,
    annotationPageLabel:
      typeof itemDataRaw.annotationPageLabel === 'string'
        ? itemDataRaw.annotationPageLabel
        : undefined,
  };

  if (Array.isArray(itemDataRaw.creators)) {
    validatedData.creators = itemDataRaw.creators
      .filter((c) => isRecord(c))
      .map((c) => ({
        creatorType:
          typeof c.creatorType === 'string' ? c.creatorType : 'author',
        firstName: typeof c.firstName === 'string' ? c.firstName : undefined,
        lastName: typeof c.lastName === 'string' ? c.lastName : undefined,
        name: typeof c.name === 'string' ? c.name : undefined,
      }));
  }

  if (Array.isArray(itemDataRaw.tags)) {
    validatedData.tags = itemDataRaw.tags
      .filter((t) => isRecord(t) && typeof t.tag === 'string')
      .map((t) => ({
        tag: String(t.tag),
        type: typeof t.type === 'number' ? t.type : 0,
      }));
  }

  if (Array.isArray(itemDataRaw.collections)) {
    validatedData.collections = itemDataRaw.collections
      .filter((colKey): colKey is string => typeof colKey === 'string')
      .map((colKey) => colKey.trim());
  }

  return {
    key,
    version,
    data: validatedData,
    meta: isRecord(raw.meta) ? raw.meta : undefined,
  };
}

/**
 * Validates an array of raw items from Zotero API.
 */
export function validateZoteroItemsArray(raw: unknown): ValidatedZoteroItem[] {
  if (!Array.isArray(raw)) {
    throw new ZoteroResponseValidationError(
      'Items response body must be an array',
      raw,
    );
  }

  return raw.map((item, index) => {
    try {
      return validateZoteroItem(item);
    } catch (err: any) {
      throw new ZoteroResponseValidationError(
        `Failed validating item at index ${index}: ${err.message}`,
        item,
      );
    }
  });
}

/**
 * Validates a single Zotero collection from unknown JSON payload.
 */
export function validateZoteroCollection(
  raw: unknown,
): ValidatedZoteroCollection {
  if (!isRecord(raw)) {
    throw new ZoteroResponseValidationError(
      'Collection payload must be a non-null object',
      raw,
    );
  }

  const key = typeof raw.key === 'string' ? raw.key.trim() : undefined;
  if (!key) {
    throw new ZoteroResponseValidationError(
      'Missing or invalid "key" property in collection',
      raw,
    );
  }

  const version =
    typeof raw.version === 'number'
      ? raw.version
      : typeof raw.version === 'string'
        ? parseInt(raw.version, 10)
        : 0;

  if (!isRecord(raw.data)) {
    throw new ZoteroResponseValidationError(
      `Missing or invalid "data" property in collection ${key}`,
      raw,
    );
  }

  const dataRaw = raw.data;
  const name =
    typeof dataRaw.name === 'string'
      ? dataRaw.name.trim()
      : `Collection ${key}`;

  const parentCollection =
    typeof dataRaw.parentCollection === 'string' &&
    dataRaw.parentCollection.trim().length > 0
      ? dataRaw.parentCollection.trim()
      : false;

  return {
    key,
    version,
    data: {
      key: typeof dataRaw.key === 'string' ? dataRaw.key : key,
      version: typeof dataRaw.version === 'number' ? dataRaw.version : version,
      name,
      parentCollection,
    },
    meta: isRecord(raw.meta) ? raw.meta : undefined,
  };
}

/**
 * Validates an array of collections from Zotero API.
 */
export function validateZoteroCollectionsArray(
  raw: unknown,
): ValidatedZoteroCollection[] {
  if (!Array.isArray(raw)) {
    throw new ZoteroResponseValidationError(
      'Collections response body must be an array',
      raw,
    );
  }

  return raw.map((col, index) => {
    try {
      return validateZoteroCollection(col);
    } catch (err: any) {
      throw new ZoteroResponseValidationError(
        `Failed validating collection at index ${index}: ${err.message}`,
        col,
      );
    }
  });
}

/**
 * Validates deleted items/collections response from Zotero API.
 */
export function validateZoteroDeletedResponse(
  raw: unknown,
): ValidatedZoteroDeletedResponse {
  if (!isRecord(raw)) {
    return { items: [], collections: [], searches: [] };
  }

  const items = Array.isArray(raw.items)
    ? raw.items.filter((k): k is string => typeof k === 'string')
    : [];

  const collections = Array.isArray(raw.collections)
    ? raw.collections.filter((k): k is string => typeof k === 'string')
    : [];

  const searches = Array.isArray(raw.searches)
    ? raw.searches.filter((k): k is string => typeof k === 'string')
    : [];

  return { items, collections, searches };
}
