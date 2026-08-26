/**
 * Universal API Response & Pagination Contracts
 *
 * Standardized for JSON API envelopes across the entire platform.
 */

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

export interface ApiResponseEnvelope<T> {
  success: true;
  data: T;
  pagination?: PaginationMeta;
  timestamp: string;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorEnvelope {
  success: false;
  error: ApiErrorDetail;
  statusCode: number;
  timestamp: string;
  path?: string;
}
