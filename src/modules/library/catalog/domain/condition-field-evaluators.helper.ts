import { Prisma } from '@prisma/client';
import { SavedSearchOperator } from '@/modules/library/catalog/types/saved-search.types';
import { AcademicSearchQueryEngine } from '@/modules/library/core';

function normalizeSavedSearchJsonValue(jsonKey: string, val: string): string {
  return AcademicSearchQueryEngine.normalizeFieldTargetValue(jsonKey, val);
}

const IDENTIFIER_FIELD_TO_TYPE: Record<string, string> = {
  doi: 'doi',
  isbn: 'isbn',
  issn: 'issn',
  pmid: 'pmid',
  pmcid: 'pmcid',
  arxivId: 'arxiv',
};

export function evalIdentifierField(
  fieldKey: string,
  operator: string,
  val: string,
): Prisma.ItemWhereInput | null {
  const canonicalType = IDENTIFIER_FIELD_TO_TYPE[fieldKey];
  if (!canonicalType) return null;
  const effectiveVal = normalizeSavedSearchJsonValue(fieldKey, val);
  const baseClause =
    fieldKey === 'doi'
      ? evalStringField('doi', operator, effectiveVal)
      : evalJsonField(fieldKey, operator, val);
  if (!baseClause) return null;

  let identClause: Prisma.ItemWhereInput | null = null;
  if (operator === 'isPresent') {
    identClause = {
      identifiers: { some: { type: canonicalType, value: { not: '' } } },
    };
    return { OR: [baseClause, identClause] };
  }
  if (operator === 'isAbsent') {
    identClause = {
      identifiers: { none: { type: canonicalType, value: { not: '' } } },
    };
    return { AND: [baseClause, identClause] };
  }
  if (operator === 'is' || operator === 'equals') {
    identClause = {
      identifiers: {
        some: {
          type: canonicalType,
          value: { equals: effectiveVal, mode: 'insensitive' },
        },
      },
    };
    return { OR: [baseClause, identClause] };
  }
  if (operator === 'contains') {
    identClause = {
      identifiers: {
        some: {
          type: canonicalType,
          value: { contains: effectiveVal, mode: 'insensitive' },
        },
      },
    };
    return { OR: [baseClause, identClause] };
  }
  if (operator === 'beginsWith') {
    identClause = {
      identifiers: {
        some: {
          type: canonicalType,
          value: { startsWith: effectiveVal, mode: 'insensitive' },
        },
      },
    };
    return { OR: [baseClause, identClause] };
  }
  if (operator === 'endsWith') {
    identClause = {
      identifiers: {
        some: {
          type: canonicalType,
          value: { endsWith: effectiveVal, mode: 'insensitive' },
        },
      },
    };
    return { OR: [baseClause, identClause] };
  }
  if (operator === 'isNot' || operator === 'not_equals') {
    identClause = {
      NOT: {
        identifiers: {
          some: {
            type: canonicalType,
            value: { equals: effectiveVal, mode: 'insensitive' },
          },
        },
      },
    };
    return { AND: [baseClause, identClause] };
  }
  if (operator === 'doesNotContain') {
    identClause = {
      NOT: {
        identifiers: {
          some: {
            type: canonicalType,
            value: { contains: effectiveVal, mode: 'insensitive' },
          },
        },
      },
    };
    return { AND: [baseClause, identClause] };
  }
  return baseClause;
}

export function evalJsonField(
  jsonKey: string,
  operator: string,
  val: string,
): Prisma.ItemWhereInput | null {
  const effectiveVal = normalizeSavedSearchJsonValue(jsonKey, val);
  if (operator === 'isPresent') {
    return {
      AND: [
        { metadata: { path: [jsonKey], not: Prisma.JsonNull } },
        { metadata: { path: [jsonKey], not: '' } },
      ],
    };
  }
  if (operator === 'isAbsent') {
    return {
      OR: [
        { metadata: { path: [jsonKey], equals: Prisma.JsonNull } },
        { metadata: { path: [jsonKey], equals: '' } },
      ],
    };
  }
  if (operator === 'is' || operator === 'equals') {
    return { metadata: { path: [jsonKey], equals: effectiveVal } };
  }
  if (operator === 'contains') {
    return { metadata: { path: [jsonKey], string_contains: effectiveVal } };
  }
  if (operator === 'isNot' || operator === 'not_equals') {
    return { NOT: { metadata: { path: [jsonKey], equals: effectiveVal } } };
  }
  if (operator === 'doesNotContain') {
    return { NOT: { metadata: { path: [jsonKey], string_contains: effectiveVal } } };
  }
  if (operator === 'beginsWith') {
    return { metadata: { path: [jsonKey], string_starts_with: effectiveVal } };
  }
  if (operator === 'endsWith') {
    return { metadata: { path: [jsonKey], string_ends_with: effectiveVal } };
  }
  return null;
}

export function evalStringField(
  fieldName: string,
  operator: string,
  val: string,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') {
    return {
      AND: [{ [fieldName]: { not: null } }, { [fieldName]: { not: '' } }],
    };
  }
  if (operator === 'isAbsent') {
    return { OR: [{ [fieldName]: null }, { [fieldName]: '' }] };
  }
  if (operator === 'is' || operator === 'equals') {
    return { [fieldName]: { equals: val, mode: 'insensitive' } };
  }
  if (operator === 'isNot' || operator === 'not_equals') {
    return { NOT: { [fieldName]: { equals: val, mode: 'insensitive' } } };
  }
  if (operator === 'contains') {
    return { [fieldName]: { contains: val, mode: 'insensitive' } };
  }
  if (operator === 'doesNotContain') {
    return { NOT: { [fieldName]: { contains: val, mode: 'insensitive' } } };
  }
  if (operator === 'beginsWith') {
    return { [fieldName]: { startsWith: val, mode: 'insensitive' } };
  }
  if (operator === 'endsWith') {
    return { [fieldName]: { endsWith: val, mode: 'insensitive' } };
  }
  return null;
}

export function evalDateField(
  fieldName: string,
  operator: SavedSearchOperator,
  value: unknown,
): Prisma.ItemWhereInput | null {
  if (operator === 'isPresent') return { [fieldName]: { not: null } };
  if (operator === 'isAbsent') return { [fieldName]: null };
  if (operator === 'isInTheLast') {
    const cutoff = parseRelativeDuration(value);
    return cutoff ? { [fieldName]: { gte: cutoff } } : null;
  }
  if (operator === 'isBetween' && Array.isArray(value)) {
    const [d1, d2] = value.map((v) => new Date(String(v)));
    if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
      return { [fieldName]: { gte: d1, lte: d2 } };
    }
    return null;
  }
  const strVal =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  const parsedDate = new Date(strVal);
  if (isNaN(parsedDate.getTime())) return null;

  if (operator === 'isGreaterThan') return { [fieldName]: { gt: parsedDate } };
  if (operator === 'isLessThan') return { [fieldName]: { lt: parsedDate } };
  if (operator === 'is' || operator === 'isNot') {
    const startOfDay = new Date(parsedDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(parsedDate);
    endOfDay.setHours(23, 59, 59, 999);
    if (operator === 'is') {
      return { [fieldName]: { gte: startOfDay, lte: endOfDay } };
    }
    return {
      OR: [
        { [fieldName]: { lt: startOfDay } },
        { [fieldName]: { gt: endOfDay } },
      ],
    };
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
  if (unit.startsWith('w')) {
    return new Date(now.getTime() - count * 7 * 86400000);
  }
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
