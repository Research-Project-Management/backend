import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma, ReadStatus } from '@prisma/client';
import { isUUID } from 'class-validator';
import { SearchQueryEngine, normalizeCanonicalItemType } from '@/modules/library/core';
import {
  SavedSearchCondition, SavedSearchConditionGroup, isConditionGroup, SavedSearchOperator, SavedSearchScopeOptions,
} from '@/modules/library/catalog/types/catalog.types';
import { FIELD_ALIASES } from '@/modules/library/catalog/types/catalog.types';

const MAX_CONDITION_DEPTH = 5;
const MAX_CONDITION_COUNT = 50;

export const DIRECT_STRING_FIELDS = new Set([
  'title', 'itemType', 'year', 'citationKey', 'doi', 'publicationTitle',
  'abstract', 'url', 'firstAuthor', 'createdAt', 'updatedAt',
]);
const UUID_ITEM_COLUMNS = new Set(['userId', 'projectId']);
export const IDENTIFIER_FIELDS = new Set(['doi', 'isbn', 'issn', 'pmid', 'pmcid', 'arxivId']);

const IDENTIFIER_FIELD_TO_TYPE: Record<string, string> = {
  doi: 'doi', isbn: 'isbn', issn: 'issn', pmid: 'pmid', pmcid: 'pmcid', arxivId: 'arxiv',
};
const PUBLICATION_TITLE_MAPPED_FIELDS = new Set([
  'bookTitle', 'proceedingsTitle', 'websiteTitle', 'dictionaryTitle',
  'encyclopediaTitle', 'blogTitle', 'forumTitle', 'programTitle',
]);
const PUBLISHER_MAPPED_FIELDS = new Set(['university', 'institution']);
const DATE_RANGE_OPERATORS = new Set<SavedSearchOperator>(['isGreaterThan', 'isLessThan', 'isBetween', 'isInTheLast']);
const NEGATIVE_COMBINATION_OPERATORS = new Set<SavedSearchOperator>(['isAbsent', 'isNot', 'doesNotContain']);
const OPERATOR_ALIASES: Record<string, SavedSearchOperator> = {
  equals: 'is', is_not: 'isNot', not_equals: 'isNot', does_not_contain: 'doesNotContain',
  begins_with: 'beginsWith', ends_with: 'endsWith', greater_than: 'isGreaterThan',
  gt: 'isGreaterThan', less_than: 'isLessThan', lt: 'isLessThan',
  between: 'isBetween', in_the_last: 'isInTheLast', is_present: 'isPresent', is_absent: 'isAbsent',
};
const SEARCH_FIELD_ALIASES: Record<string, string> = {
  author: 'creator', authors: 'creator', contributor: 'creator', contributors: 'creator',
  venue: 'publicationTitle', publication: 'publicationTitle', publication_title: 'publicationTitle',
  hasPdf: 'hasAttachment', has_pdf: 'hasAttachment', has_attachment: 'hasAttachment',
  hasFile: 'hasAttachment', attachmentCount: 'hasAttachment',
  has_notes: 'hasNotes', noteCount: 'hasNotes',
  notes: 'noteContent',
  annotationText: 'annotation',
  read_status: 'readStatus', readingStatus: 'readStatus',
  is_starred: 'isStarred', starred: 'isStarred',
  is_retracted: 'isRetracted', retracted: 'isRetracted',
  item_type: 'itemType', citation_key: 'citationKey', citekey: 'citationKey',
  arxiv: 'arxivId', arxiv_id: 'arxivId', archiveId: 'arxivId', archiveID: 'arxivId',
};

function normalizeSavedSearchJsonValue(jsonKey: string, val: string): string {
  return SearchQueryEngine.normalizeFieldTargetValue(jsonKey, val);
}

function buildCaseInsensitiveStringFilter(operator: string, val: string, treatIsAsContains = false): Prisma.StringFilter | null {
  if (operator === 'is' || operator === 'equals' || operator === 'isNot' || operator === 'not_equals') {
    return treatIsAsContains ? { contains: val, mode: 'insensitive' } : { equals: val, mode: 'insensitive' };
  }
  if (operator === 'contains' || operator === 'doesNotContain') return { contains: val, mode: 'insensitive' };
  if (operator === 'beginsWith') return { startsWith: val, mode: 'insensitive' };
  if (operator === 'endsWith') return { endsWith: val, mode: 'insensitive' };
  return null;
}

const isNegatedStringOp = (op: string) => op === 'isNot' || op === 'not_equals' || op === 'doesNotContain';

export function evalIdentifierField(fieldKey: string, operator: string, val: string): Prisma.ItemWhereInput | null {
  const canonicalType = IDENTIFIER_FIELD_TO_TYPE[fieldKey];
  if (!canonicalType) return null;
  const effectiveVal = normalizeSavedSearchJsonValue(fieldKey, val);
  const topColClause = evalStringField(fieldKey, operator, effectiveVal);
  const jsonClause = fieldKey === 'doi' ? null : evalJsonField(fieldKey, operator, val);
  const baseClause = jsonClause || topColClause;
  if (!baseClause) return null;
  const colAndJsonPositive = topColClause && jsonClause ? [topColClause, jsonClause] : [baseClause];
  const colAndJsonNegative = topColClause && jsonClause ? [topColClause, jsonClause] : [baseClause];
  if (operator === 'isPresent') {
    return { OR: [...colAndJsonPositive, { identifiers: { some: { type: canonicalType, value: { not: '' } } } }] };
  }
  if (operator === 'isAbsent') {
    return { AND: [...colAndJsonNegative, { identifiers: { none: { type: canonicalType, value: { not: '' } } } }] };
  }
  const strFilter = buildCaseInsensitiveStringFilter(operator, effectiveVal, false);
  if (!strFilter) return baseClause;
  const someIdent: Prisma.ItemWhereInput = { identifiers: { some: { type: canonicalType, value: strFilter } } };
  return isNegatedStringOp(operator)
    ? { AND: [...colAndJsonNegative, { NOT: someIdent }] }
    : { OR: [...colAndJsonPositive, someIdent] };
}

export function evalJsonField(jsonKey: string, operator: string, val: string): Prisma.ItemWhereInput | null {
  const effectiveVal = normalizeSavedSearchJsonValue(jsonKey, val);
  if (operator === 'isPresent') {
    return { AND: [{ metadata: { path: [jsonKey], not: Prisma.JsonNull } }, { metadata: { path: [jsonKey], not: '' } }] };
  }
  if (operator === 'isAbsent') {
    return { OR: [{ metadata: { path: [jsonKey], equals: Prisma.JsonNull } }, { metadata: { path: [jsonKey], equals: '' } }] };
  }
  if (operator === 'is' || operator === 'equals') return { metadata: { path: [jsonKey], equals: effectiveVal } };
  if (operator === 'contains') return { metadata: { path: [jsonKey], string_contains: effectiveVal } };
  if (operator === 'isNot' || operator === 'not_equals') {
    return { NOT: { metadata: { path: [jsonKey], equals: effectiveVal } } };
  }
  if (operator === 'doesNotContain') return { NOT: { metadata: { path: [jsonKey], string_contains: effectiveVal } } };
  if (operator === 'beginsWith') return { metadata: { path: [jsonKey], string_starts_with: effectiveVal } };
  if (operator === 'endsWith') return { metadata: { path: [jsonKey], string_ends_with: effectiveVal } };
  return null;
}

export function evalStringField(fieldName: string, operator: string, val: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { AND: [{ [fieldName]: { not: null } }, { [fieldName]: { not: '' } }] };
  if (operator === 'isAbsent') return { OR: [{ [fieldName]: null }, { [fieldName]: '' }] };
  const strFilter = buildCaseInsensitiveStringFilter(operator, val, false);
  if (!strFilter) return null;
  return isNegatedStringOp(operator) ? { NOT: { [fieldName]: strFilter } } : { [fieldName]: strFilter };
}

export function evalDateField(fieldName: string, operator: SavedSearchOperator, value: unknown): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { [fieldName]: { not: null } };
  if (operator === 'isAbsent') return { [fieldName]: null };
  if (operator === 'isInTheLast') {
    const cutoff = parseRelativeDuration(value);
    return cutoff ? { [fieldName]: { gte: cutoff } } : null;
  }
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [d1, d2] = value.map((v) => new Date(String(v)));
    return !isNaN(d1.getTime()) && !isNaN(d2.getTime()) ? { [fieldName]: { gte: d1, lte: d2 } } : null;
  }
  const strVal = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const parsedDate = new Date(strVal);
  if (isNaN(parsedDate.getTime())) return null;
  if (operator === 'isGreaterThan') return { [fieldName]: { gt: parsedDate } };
  if (operator === 'isLessThan') return { [fieldName]: { lt: parsedDate } };
  if (operator === 'is' || operator === 'isNot') {
    const startOfDay = new Date(parsedDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(parsedDate);
    endOfDay.setHours(23, 59, 59, 999);
    return operator === 'is'
      ? { [fieldName]: { gte: startOfDay, lte: endOfDay } }
      : { OR: [{ [fieldName]: { lt: startOfDay } }, { [fieldName]: { gt: endOfDay } }] };
  }
  return null;
}

export function parseRelativeDuration(value: unknown): Date | null {
  let count = 30;
  let unit = 'days';
  if (typeof value === 'object' && value !== null) {
    const obj = value as { count?: unknown; unit?: unknown };
    if (obj.count !== undefined) count = Number(obj.count);
    if (typeof obj.unit === 'string') unit = obj.unit.toLowerCase();
  } else if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+)\s*([a-zA-Z]+)?$/);
    if (match) {
      count = parseInt(match[1], 10);
      if (match[2]) unit = match[2].toLowerCase();
    } else {
      const num = Number(value.trim());
      if (Number.isFinite(num)) count = num;
    }
  } else if (typeof value === 'number') {
    count = value;
  }
  if (!Number.isFinite(count) || count <= 0) return null;
  const now = new Date();
  if (unit.startsWith('d')) return new Date(now.getTime() - count * 86400000);
  if (unit.startsWith('w')) return new Date(now.getTime() - count * 7 * 86400000);
  if (unit.startsWith('m')) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - count);
    return d;
  }
  if (unit.startsWith('y')) {
    const d = new Date(now);
    d.setFullYear(d.getFullYear() - count);
    return d;
  }
  return new Date(now.getTime() - count * 86400000);
}

export function evalAnyFieldCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') {
    return {
      OR: [
        { title: { not: '' } },
        { abstract: { not: '' } },
        { publicationTitle: { not: '' } },
        { contributors: { some: {} } },
      ],
    };
  }
  if (operator === 'isAbsent') {
    return {
      AND: [{ title: '' }, { abstract: '' }, { publicationTitle: '' }, { contributors: { none: {} } }],
    };
  }
  const anyFieldClauses = SearchQueryEngine.buildComprehensiveItemSearchClauses(
    strVal,
    'everything',
    { includeExtraMetadata: true },
  ) as Prisma.ItemWhereInput[];
  return operator === 'doesNotContain' || operator === 'isNot'
    ? { NOT: { OR: anyFieldClauses } }
    : { OR: anyFieldClauses };
}

export function evalCreatorCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') {
    return {
      OR: [
        { contributors: { some: {} } },
        { AND: [{ firstAuthor: { not: null } }, { firstAuthor: { not: '' } }] },
      ],
    };
  }
  if (operator === 'isAbsent') {
    return {
      AND: [
        { contributors: { none: {} } },
        { OR: [{ firstAuthor: null }, { firstAuthor: '' }] },
      ],
    };
  }
  const filter = buildCaseInsensitiveStringFilter(operator, strVal, true);
  if (!filter) return null;
  const someClause: Prisma.ItemWhereInput = {
    OR: [
      {
        contributors: {
          some: {
            OR: [
              { fullName: filter },
              { lastName: filter },
              { firstName: filter },
            ],
          },
        },
      },
      { firstAuthor: filter },
    ],
  };
  return isNegatedStringOp(operator) ? { NOT: someClause } : someClause;
}

export function evalYearCondition(operator: SavedSearchOperator, value: unknown): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { year: { not: null } };
  if (operator === 'isAbsent') return { year: null };
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [start, end] = value.map(Number);
    return Number.isFinite(start) && Number.isFinite(end) ? { year: { gte: start, lte: end } } : null;
  }
  const numVal = Number(value);
  if (!Number.isFinite(numVal)) return null;
  if (operator === 'is' || operator === 'equals') return { year: numVal };
  if (operator === 'isNot' || operator === 'not_equals') return { NOT: { year: numVal } };
  if (operator === 'isGreaterThan') return { year: { gt: numVal } };
  if (operator === 'isLessThan') return { year: { lt: numVal } };
  return null;
}

export function evalItemTypeCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { itemType: { not: '' } };
  if (operator === 'isAbsent') return { itemType: '' };
  const canonicalType = normalizeCanonicalItemType(strVal);
  if (operator === 'is' || operator === 'equals') return { itemType: canonicalType };
  if (operator === 'isNot' || operator === 'not_equals') return { NOT: { itemType: canonicalType } };
  if (operator === 'contains') return { itemType: { contains: strVal, mode: 'insensitive' } };
  if (operator === 'doesNotContain') return { NOT: { itemType: { contains: strVal, mode: 'insensitive' } } };
  return null;
}

export function evalTagCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { itemTags: { some: {} } };
  if (operator === 'isAbsent') return { itemTags: { none: {} } };
  const filter = buildCaseInsensitiveStringFilter(operator, strVal, true);
  if (!filter) return null;
  const someClause: Prisma.ItemWhereInput = { itemTags: { some: { tag: { name: filter } } } };
  return isNegatedStringOp(operator) ? { NOT: someClause } : someClause;
}

export function evalCollectionCondition(operator: SavedSearchOperator, strVal: string, descendantMap?: Map<string, string[]>): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { collectionItems: { some: { collection: { deletedAt: null } } } };
  if (operator === 'isAbsent') return { collectionItems: { none: { collection: { deletedAt: null } } } };
  if (!strVal) return null;
  if (descendantMap?.has(strVal)) {
    const targetIds = descendantMap.get(strVal)!;
    const collectionCondition =
      targetIds.length === 1
        ? { collectionId: targetIds[0], collection: { deletedAt: null } }
        : { collectionId: { in: targetIds }, collection: { deletedAt: null } };
    if (operator === 'is' || operator === 'equals' || operator === 'contains') return { collectionItems: { some: collectionCondition } };
    return isNegatedStringOp(operator) ? { NOT: { collectionItems: { some: collectionCondition } } } : null;
  }
  if (!isUUID(strVal)) {
    const nameFilter =
      operator === 'contains' || operator === 'doesNotContain'
        ? { contains: strVal, mode: 'insensitive' as const }
        : { equals: strVal, mode: 'insensitive' as const };
    const nameCondition: Prisma.CollectionItemWhereInput = {
      collection: { name: nameFilter, deletedAt: null },
    };
    if (operator === 'is' || operator === 'equals' || operator === 'contains') {
      return { collectionItems: { some: nameCondition } };
    }
    return isNegatedStringOp(operator) ? { NOT: { collectionItems: { some: nameCondition } } } : null;
  }
  const targetIds = [strVal];
  const collectionCondition = { collectionId: targetIds[0], collection: { deletedAt: null } };
  if (operator === 'is' || operator === 'equals' || operator === 'contains') return { collectionItems: { some: collectionCondition } };
  return isNegatedStringOp(operator) ? { NOT: { collectionItems: { some: collectionCondition } } } : null;
}

export function evalHasNotesCondition(
  operator: SavedSearchOperator,
  value: unknown,
  strVal: string,
): Prisma.ItemWhereInput | null {
  const isNegativeOp =
    operator === 'isAbsent' ||
    operator === 'isNot' ||
    value === false ||
    strVal === 'false' ||
    value === 0 ||
    strVal === '0';
  return !isNegativeOp ? { noteCount: { gt: 0 } } : { noteCount: 0 };
}

export function evalIsRetractedCondition(
  operator: SavedSearchOperator,
  value: unknown,
  strVal: string,
): Prisma.ItemWhereInput | null {
  const isNegativeOp =
    operator === 'isAbsent' ||
    operator === 'isNot' ||
    value === false ||
    strVal === 'false' ||
    value === 0 ||
    strVal === '0';
  return !isNegativeOp
    ? {
        OR: [
          { isRetracted: true },
          { metadata: { path: ['isRetracted'], equals: true } },
        ],
      }
    : {
        NOT: {
          OR: [
            { isRetracted: true },
            { metadata: { path: ['isRetracted'], equals: true } },
          ],
        },
      };
}

export function evalUserStarredCondition(operator: SavedSearchOperator, value: unknown, strVal: string, userId?: string): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  const wantStarred = operator !== 'isAbsent' && operator !== 'isNot' && value !== false && strVal !== 'false';
  return wantStarred
    ? { states: { some: { userId, isStarred: true } } }
    : { OR: [{ states: { none: { userId } } }, { states: { some: { userId, isStarred: false } } }] };
}

export function evalReadStatusCondition(operator: SavedSearchOperator, strVal: string, userId?: string): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  const mappedStatus = strVal === 'read' ? 'completed' : strVal;
  const targetStatus: ReadStatus = mappedStatus === 'reading' || mappedStatus === 'completed' ? mappedStatus : 'unread';
  if (operator === 'isNot') {
    return targetStatus === 'unread'
      ? { states: { some: { userId, readStatus: { not: 'unread' } } } }
      : { OR: [{ states: { none: { userId } } }, { states: { some: { userId, readStatus: { not: targetStatus } } } }] };
  }
  return targetStatus === 'unread'
    ? { OR: [{ states: { none: { userId } } }, { states: { some: { userId, readStatus: 'unread' } } }] }
    : { states: { some: { userId, readStatus: targetStatus } } };
}

export function evalRatingCondition(operator: SavedSearchOperator, value: unknown, userId?: string): Prisma.ItemWhereInput | null {
  if (!userId) return null;
  if (operator === 'isPresent') return { states: { some: { userId, rating: { not: null, gt: 0 } } } };
  if (operator === 'isAbsent') {
    return { OR: [{ states: { none: { userId } } }, { states: { some: { userId, OR: [{ rating: null }, { rating: 0 }] } } }] };
  }
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [start, end] = value.map(Number);
    return Number.isFinite(start) && Number.isFinite(end) ? { states: { some: { userId, rating: { gte: start, lte: end } } } } : null;
  }
  const ratingNum = Number(value);
  if (!Number.isFinite(ratingNum)) return null;
  if (operator === 'isGreaterThan') return { states: { some: { userId, rating: { gt: ratingNum } } } };
  if (operator === 'isLessThan') return { states: { some: { userId, rating: { lt: ratingNum } } } };
  if (operator === 'isNot') return { OR: [{ states: { none: { userId } } }, { states: { some: { userId, NOT: { rating: ratingNum } } } }] };
  return { states: { some: { userId, rating: ratingNum } } };
}

export function evalAttachmentCondition(
  field: 'hasAttachment' | 'attachmentContent' | 'attachmentFilename',
  operator: SavedSearchOperator,
  value: unknown,
  strVal: string,
): Prisma.ItemWhereInput | null {
  if (field === 'hasAttachment') {
    const isNegativeOp =
      operator === 'isAbsent' ||
      operator === 'isNot' ||
      value === false ||
      strVal === 'false' ||
      value === 0 ||
      strVal === '0';
    return !isNegativeOp ? { hasFile: true } : { hasFile: false };
  }
  if (field === 'attachmentFilename') {
    if (operator === 'isPresent') return { attachments: { some: { deletedAt: null } } };
    if (operator === 'isAbsent') return { attachments: { none: { deletedAt: null } } };
    const matchClause: Prisma.ItemWhereInput = { attachments: { some: { deletedAt: null, filename: { contains: strVal, mode: 'insensitive' } } } };
    if (operator === 'contains' || operator === 'is') return matchClause;
    return operator === 'doesNotContain' || operator === 'isNot' ? { NOT: matchClause } : null;
  }
  if (operator === 'isPresent') return { attachments: { some: { deletedAt: null, fullTextIndexes: { some: {} } } } };
  if (operator === 'isAbsent') return { attachments: { none: { deletedAt: null, fullTextIndexes: { some: {} } } } };
  const contentClause: Prisma.ItemWhereInput = {
    attachments: { some: { deletedAt: null, fullTextIndexes: { some: { textContent: { contains: strVal, mode: 'insensitive' } } } } },
  };
  if (operator === 'contains' || operator === 'is') return contentClause;
  return operator === 'doesNotContain' || operator === 'isNot' ? { NOT: contentClause } : null;
}

export function evalNoteCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { notesList: { some: { deletedAt: null } } };
  if (operator === 'isAbsent') return { notesList: { none: { deletedAt: null } } };
  const noteOr: Prisma.NoteWhereInput[] = [
    { title: { contains: strVal, mode: 'insensitive' as const } },
    { contentMd: { contains: strVal, mode: 'insensitive' as const } },
  ];
  if (operator === 'contains' || operator === 'is') return { notesList: { some: { deletedAt: null, OR: noteOr } } };
  return operator === 'doesNotContain' || operator === 'isNot'
    ? { NOT: { notesList: { some: { deletedAt: null, OR: noteOr } } } }
    : null;
}

export function evalAnnotationCondition(operator: SavedSearchOperator, strVal: string): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') {
    return { attachments: { some: { deletedAt: null, annotations: { some: { deletedAt: null } } } } };
  }
  if (operator === 'isAbsent') {
    return { attachments: { none: { deletedAt: null, annotations: { some: { deletedAt: null } } } } };
  }
  const annOr: Prisma.AnnotationWhereInput[] = [
    { quoteText: { contains: strVal, mode: 'insensitive' as const } },
    { comment: { contains: strVal, mode: 'insensitive' as const } },
    ...(strVal ? [{ tags: { has: strVal } }] : []),
  ];
  const matchClause: Prisma.ItemWhereInput = {
    attachments: { some: { deletedAt: null, annotations: { some: { deletedAt: null, OR: annOr } } } },
  };
  if (operator === 'contains' || operator === 'is') return matchClause;
  return operator === 'doesNotContain' || operator === 'isNot' ? { NOT: matchClause } : null;
}

function extractYearNumber(raw: unknown): number {
  const str = String(raw ?? '').trim();
  const match = str.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1], 10) : Number(str);
}

export interface FieldEvaluatorContext {
  normalizedField: string;
  operator: SavedSearchOperator;
  value: unknown;
  strVal: string;
  userId?: string;
  descendantMap?: Map<string, string[]>;
}

export type FieldEvaluatorStrategy = (ctx: FieldEvaluatorContext) => Prisma.ItemWhereInput | null;

function evalPublicationDateStrategy(ctx: FieldEvaluatorContext): Prisma.ItemWhereInput | null {
  const { operator, value, strVal } = ctx;
  if (DATE_RANGE_OPERATORS.has(operator)) {
    if (operator === 'isInTheLast') {
      const cutoff = parseRelativeDuration(value);
      return cutoff ? { year: { gte: cutoff.getFullYear() } } : null;
    }
    if (operator === 'isBetween' && Array.isArray(value)) {
      return evalYearCondition('isBetween', [extractYearNumber(value[0]), extractYearNumber(value[1])]);
    }
    return evalYearCondition(operator, extractYearNumber(value ?? strVal));
  }
  return evalJsonField('publicationDate', operator, strVal);
}

function evalAccessedAtStrategy(ctx: FieldEvaluatorContext): Prisma.ItemWhereInput | null {
  const { operator, value, strVal } = ctx;
  const directJson = evalJsonField('accessedAt', operator, strVal);
  if (directJson) return directJson;
  if (DATE_RANGE_OPERATORS.has(operator)) {
    if (operator === 'isInTheLast') {
      const cutoff = parseRelativeDuration(value);
      if (!cutoff) return null;
      const yearPrefix = String(cutoff.getUTCFullYear());
      return {
        AND: [
          { metadata: { path: ['accessedAt'], not: Prisma.JsonNull } },
          { metadata: { path: ['accessedAt'], string_contains: yearPrefix } },
        ],
      };
    }
    const isoPrefix = strVal.slice(0, 10);
    if (isoPrefix) {
      return { metadata: { path: ['accessedAt'], string_starts_with: isoPrefix } };
    }
  }
  return null;
}

export const FIELD_EVALUATOR_STRATEGIES: Readonly<Record<string, FieldEvaluatorStrategy>> = {
  anyField: ({ operator, strVal }) => evalAnyFieldCondition(operator, strVal),
  creator: ({ operator, strVal }) => evalCreatorCondition(operator, strVal),
  year: ({ operator, value }) => evalYearCondition(operator, value),
  itemType: ({ operator, strVal }) => evalItemTypeCondition(operator, strVal),
  tag: ({ operator, strVal }) => evalTagCondition(operator, strVal),
  collection: ({ operator, strVal, descendantMap }) => evalCollectionCondition(operator, strVal, descendantMap),
  hasAttachment: ({ operator, value, strVal }) => evalAttachmentCondition('hasAttachment', operator, value, strVal),
  hasPdf: ({ operator, value, strVal }) => evalAttachmentCondition('hasAttachment', operator, value, strVal),
  hasNotes: ({ operator, value, strVal }) => evalHasNotesCondition(operator, value, strVal),
  isRetracted: ({ operator, value, strVal }) => evalIsRetractedCondition(operator, value, strVal),
  isStarred: ({ operator, value, strVal, userId }) => evalUserStarredCondition(operator, value, strVal, userId),
  readStatus: ({ operator, strVal, userId }) => evalReadStatusCondition(operator, strVal, userId),
  rating: ({ operator, value, userId }) => evalRatingCondition(operator, value, userId),
  dateAdded: ({ operator, value }) => evalDateField('createdAt', operator, value),
  dateModified: ({ operator, value }) => evalDateField('updatedAt', operator, value),
  publicationDate: evalPublicationDateStrategy,
  date: evalPublicationDateStrategy,
  accessedAt: evalAccessedAtStrategy,
  accessDate: evalAccessedAtStrategy,
  attachmentContent: ({ operator, value, strVal }) => evalAttachmentCondition('attachmentContent', operator, value, strVal),
  attachmentFilename: ({ operator, value, strVal }) => evalAttachmentCondition('attachmentFilename', operator, value, strVal),
  filename: ({ operator, value, strVal }) => evalAttachmentCondition('attachmentFilename', operator, value, strVal),
  noteContent: ({ operator, strVal }) => evalNoteCondition(operator, strVal),
  note: ({ operator, strVal }) => evalNoteCondition(operator, strVal),
  annotation: ({ operator, strVal }) => evalAnnotationCondition(operator, strVal),
  annotations: ({ operator, strVal }) => evalAnnotationCondition(operator, strVal),
};

function evaluateDefaultFieldStrategy(ctx: FieldEvaluatorContext): Prisma.ItemWhereInput | null {
  const { normalizedField, operator, strVal } = ctx;
  if (IDENTIFIER_FIELDS.has(normalizedField)) return evalIdentifierField(normalizedField, operator, strVal);
  if (UUID_ITEM_COLUMNS.has(normalizedField)) {
    if (operator === 'isPresent') return { [normalizedField]: { not: null } };
    if (operator === 'isAbsent') return { [normalizedField]: null };
    if (operator === 'is') {
      if (!strVal) return null;
      return isUUID(strVal) ? { [normalizedField]: strVal } : { id: '00000000-0000-0000-0000-000000000000' };
    }
    if (operator === 'isNot') {
      if (!strVal) return null;
      return isUUID(strVal) ? { NOT: { [normalizedField]: strVal } } : { id: { not: '00000000-0000-0000-0000-000000000000' } };
    }
    return null;
  }
  if (PUBLICATION_TITLE_MAPPED_FIELDS.has(normalizedField)) {
    const pair = [evalJsonField(normalizedField, operator, strVal), evalStringField('publicationTitle', operator, strVal)].filter(
      (c): c is Prisma.ItemWhereInput => c !== null,
    );
    if (pair.length === 0) return null;
    return NEGATIVE_COMBINATION_OPERATORS.has(operator) ? { AND: pair } : { OR: pair };
  }
  if (PUBLISHER_MAPPED_FIELDS.has(normalizedField)) {
    const pair = [evalJsonField(normalizedField, operator, strVal), evalJsonField('publisher', operator, strVal)].filter(
      (c): c is Prisma.ItemWhereInput => c !== null,
    );
    if (pair.length === 0) return null;
    return NEGATIVE_COMBINATION_OPERATORS.has(operator) ? { AND: pair } : { OR: pair };
  }
  return DIRECT_STRING_FIELDS.has(normalizedField)
    ? evalStringField(normalizedField, operator, strVal)
    : evalJsonField(normalizedField, operator, strVal);
}

@Injectable()
export class ConditionEvaluatorEngine {
  private validateGroupStructure(
    group: SavedSearchConditionGroup,
    depth: number = 0,
    counter: { count: number; collectionIds: string[] } = { count: 0, collectionIds: [] },
  ): string[] {
    if (!group || typeof group !== 'object' || !Array.isArray(group.conditions)) {
      throw new BadRequestException('Invalid condition group structure');
    }
    if (depth > MAX_CONDITION_DEPTH) {
      throw new BadRequestException(
        `Saved search condition nesting depth exceeds maximum allowed (${MAX_CONDITION_DEPTH})`,
      );
    }
    for (const item of group.conditions) {
      if (!item || typeof item !== 'object') throw new BadRequestException('Invalid condition element');
      if (isConditionGroup(item)) {
        this.validateGroupStructure(item, depth + 1, counter);
      } else {
        counter.count += 1;
        if (counter.count > MAX_CONDITION_COUNT) {
          throw new BadRequestException(
            `Saved search condition count exceeds maximum allowed (${MAX_CONDITION_COUNT})`,
          );
        }
        if (!item.field || typeof item.field !== 'string' || !item.operator || typeof item.operator !== 'string') {
          throw new BadRequestException('Condition must have valid field and operator');
        }
        if (item.field === 'collection' && item.value && typeof item.value === 'string' && item.value.trim()) {
          counter.collectionIds.push(item.value.trim());
        }
      }
    }
    return [...new Set(counter.collectionIds)];
  }

  extractReferencedCollectionIds(group: SavedSearchConditionGroup | null | undefined): string[] {
    if (!group || typeof group !== 'object' || !Array.isArray(group.conditions) || !group.conditions.length) {
      return [];
    }
    const optionsFallback =
      'options' in group && group.options && typeof group.options === 'object'
        ? (group.options as SavedSearchScopeOptions)
        : {};
    const scopeOptions = group.scopeOptions || optionsFallback;
    if (scopeOptions.searchSubcollections === false) return [];
    return this.validateGroupStructure(group);
  }

  compile(
    userId: string,
    group: SavedSearchConditionGroup,
    projectId?: string,
    descendantMap: Map<string, string[]> = new Map(),
  ): Prisma.ItemWhereInput {
    const baseWhere: Prisma.ItemWhereInput = projectId
      ? { projectId, deletedAt: null }
      : { userId, projectId: null, deletedAt: null };
    if (!group) return baseWhere;
    if (typeof group !== 'object' || (group.conditions !== undefined && !Array.isArray(group.conditions))) {
      throw new BadRequestException('Invalid saved search conditions');
    }
    if (!group.conditions?.length) return baseWhere;

    this.validateGroupStructure(group);
    return this.buildCompiledQuery(group, userId, baseWhere, descendantMap);
  }

  private buildCompiledQuery(
    group: SavedSearchConditionGroup,
    userId: string,
    baseWhere: Prisma.ItemWhereInput,
    descendantMap: Map<string, string[]>,
  ): Prisma.ItemWhereInput {
    const optionsFallback =
      'options' in group && group.options && typeof group.options === 'object'
        ? (group.options as SavedSearchScopeOptions)
        : {};
    const scopeOptions = group.scopeOptions || optionsFallback;
    const andConditions: Prisma.ItemWhereInput[] = [baseWhere, this.evaluateGroup(group, userId, descendantMap)];
    if (scopeOptions.showOnlyTopLevel) {
      andConditions.push({ itemType: { notIn: ['attachment', 'annotation', 'note'] } });
    }
    return { AND: andConditions };
  }

  private evaluateGroup(
    group: SavedSearchConditionGroup,
    userId?: string,
    descendantMap?: Map<string, string[]>,
    depth: number = 0,
    counter: { count: number } = { count: 0 },
  ): Prisma.ItemWhereInput {
    if (depth > MAX_CONDITION_DEPTH) {
      throw new BadRequestException(
        `Saved search condition nesting depth exceeds maximum allowed (${MAX_CONDITION_DEPTH})`,
      );
    }
    if (!group || typeof group !== 'object' || !Array.isArray(group.conditions)) return {};
    const clauses: Prisma.ItemWhereInput[] = [];
    for (const item of group.conditions) {
      if (!item || typeof item !== 'object') continue;
      if (isConditionGroup(item)) {
        clauses.push(this.evaluateGroup(item, userId, descendantMap, depth + 1, counter));
      } else {
        counter.count += 1;
        if (counter.count > MAX_CONDITION_COUNT) {
          throw new BadRequestException(
            `Saved search condition count exceeds maximum allowed (${MAX_CONDITION_COUNT})`,
          );
        }
        const leafClause = this.evaluateCondition(item, userId, descendantMap);
        if (leafClause) clauses.push(leafClause);
      }
    }
    if (clauses.length === 0) return {};
    const mode = (group.conjunction || group.matchMode || 'AND').toUpperCase();
    return mode === 'OR' || mode === 'ANY' ? { OR: clauses } : { AND: clauses };
  }

  evaluateLeaf(
    cond: SavedSearchCondition,
    userId?: string,
    descendantMap?: Map<string, string[]>,
  ): Prisma.ItemWhereInput | null {
    return this.evaluateCondition(cond, userId, descendantMap);
  }

  private evaluateCondition(
    cond: SavedSearchCondition,
    userId?: string,
    descendantMap?: Map<string, string[]>,
  ): Prisma.ItemWhereInput | null {
    if (!cond || typeof cond !== 'object') return null;
    const { field, operator: rawOperator, value } = cond;
    if (!field || typeof field !== 'string' || !rawOperator || typeof rawOperator !== 'string') return null;
    const operator: SavedSearchOperator = OPERATOR_ALIASES[rawOperator] || rawOperator;
    const strVal =
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).trim() : '';
    const normalizedField = SEARCH_FIELD_ALIASES[field] || FIELD_ALIASES[field] || field;
    const ctx: FieldEvaluatorContext = { normalizedField, operator, value, strVal, userId, descendantMap };
    const registeredStrategy = FIELD_EVALUATOR_STRATEGIES[normalizedField];
    return registeredStrategy ? registeredStrategy(ctx) : evaluateDefaultFieldStrategy(ctx);
  }
}
