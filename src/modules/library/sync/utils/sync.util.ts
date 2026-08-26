/**
 * Sync Subsystem Envelope & Pagination Contracts
 */

export interface PaginationMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasMore?: boolean;
  nextCursor?: string;
  prevCursor?: string;
}

export interface ResponseMeta {
  requestId?: string;
  timestamp?: string;
  version?: string;
  cached?: boolean;
  executionTimeMs?: number;
  [key: string]: unknown;
}

export interface ApiResponse<T> {
  data: T;
  pagination?: PaginationMeta;
  meta?: ResponseMeta;
}

export interface ApiErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  errors?: string[];
  requestId?: string;
  timestamp: string;
  path?: string;
}

/**
 * Wraps payload in unified ApiResponse envelope
 */
export function wrapResponse<T>(
  data: T,
  pagination?: PaginationMeta,
  meta?: ResponseMeta,
): ApiResponse<T> {
  return {
    data,
    ...(pagination ? { pagination } : {}),
    meta: {
      timestamp: new Date().toISOString(),
      version: 'v1',
      ...meta,
    },
  };
}

/**
 * Computes standard pagination metadata from page, limit, and total count
 */
export function createPaginationMeta(
  total: number,
  page: number = 1,
  limit: number = 20,
  nextCursor?: string,
): PaginationMeta {
  const safeLimit = Math.max(1, limit);
  const totalPages = Math.ceil(total / safeLimit);
  const safePage = Math.max(1, page);
  const hasMore = safePage < totalPages || Boolean(nextCursor);

  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages,
    hasMore,
    nextCursor,
  };
}
