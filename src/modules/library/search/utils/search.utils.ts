import { Prisma } from '@prisma/client';
import { SearchOptions } from '../types/search.types';

/**
 * Sanitizes search input to prevent SQL injection or tsquery syntax breaking.
 */
export function sanitizeSearchQuery(query?: string): string {
  if (!query) return '';
  return query
    .replace(/['":*&|!()\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Converts space-separated search query into PostgreSQL tsquery syntax (term1 & term2:*).
 */
export function formatToPrefixTsQuery(query: string): string {
  const sanitized = sanitizeSearchQuery(query);
  if (!sanitized) return '';
  const tokens = sanitized.split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `${token}:*`).join(' & ');
}

/**
 * Builds Prisma WhereInput object for structured metadata filtering in search.
 */
export function buildBaseSearchWhere(
  workspaceId: string,
  options: SearchOptions,
): Prisma.CatalogItemWhereInput {
  return {
    workspaceId,
    deletedAt: null,
    ...(options.itemType ? { itemType: options.itemType } : {}),
    ...(options.yearFrom || options.yearTo
      ? {
          year: {
            ...(options.yearFrom ? { gte: options.yearFrom } : {}),
            ...(options.yearTo ? { lte: options.yearTo } : {}),
          },
        }
      : {}),
    ...(options.collectionId
      ? {
          collectionItems: {
            some: { collectionId: options.collectionId },
          },
        }
      : {}),
    ...(options.tagId
      ? {
          itemTags: {
            some: { tagId: options.tagId },
          },
        }
      : {}),
  };
}
