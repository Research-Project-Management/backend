import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// ── 1. Domain Error Codes ───────────────────────────────────────────────────

export enum LibraryDomainErrorCode {
  ITEM_NOT_FOUND = 'ITEM_NOT_FOUND',
  COLLECTION_NOT_FOUND = 'COLLECTION_NOT_FOUND',
  ATTACHMENT_NOT_FOUND = 'ATTACHMENT_NOT_FOUND',
  ANNOTATION_NOT_FOUND = 'ANNOTATION_NOT_FOUND',
  NOTE_NOT_FOUND = 'NOTE_NOT_FOUND',
  TAG_NOT_FOUND = 'TAG_NOT_FOUND',
  VERSION_MISMATCH = 'VERSION_MISMATCH',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',
  WORKSPACE_ISOLATION_VIOLATION = 'WORKSPACE_ISOLATION_VIOLATION',
  CYCLIC_COLLECTION_REFERENCE = 'CYCLIC_COLLECTION_REFERENCE',
  INVALID_CHECKSUM = 'INVALID_CHECKSUM',
  STORAGE_LIMIT_EXCEEDED = 'STORAGE_LIMIT_EXCEEDED',
  UNSUPPORTED_ATTACHMENT_TYPE = 'UNSUPPORTED_ATTACHMENT_TYPE',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  OUTBOX_SEQUENCE_GAP = 'OUTBOX_SEQUENCE_GAP',
  INVALID_PAYLOAD = 'INVALID_PAYLOAD',
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',
}

// ── 2. Canonical Response Envelope Contracts ────────────────────────────────

export interface ApiMeta {
  requestId?: string;
  timestamp?: string;
  version?: string;
  cursor?: string;
  hasNextPage?: boolean;
  totalCount?: number;
  [key: string]: unknown;
}

export interface ApiSuccessResult<T> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorDetail {
  code: string | LibraryDomainErrorCode;
  message: string;
  details?: unknown;
}

export interface ApiErrorResult {
  success: false;
  error: ApiErrorDetail;
}

export type ApiResult<T> = ApiSuccessResult<T> | ApiErrorResult;

// ── 3. Canonical Pagination Contracts ───────────────────────────────────────

export enum PaginationDirection {
  FORWARD = 'forward',
  BACKWARD = 'backward',
}

export class CursorPaginationQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsEnum(PaginationDirection)
  direction?: PaginationDirection = PaginationDirection.FORWARD;
}

export interface CursorPaginationMeta {
  cursor?: string;
  hasNextPage: boolean;
  hasPrevPage?: boolean;
  totalCount?: number;
}

export interface CursorPaginatedResult<T> {
  items: T[];
  meta: CursorPaginationMeta;
}

export class OffsetPaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 50;
}

export interface OffsetPaginationMeta {
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
}

export interface OffsetPaginatedResult<T> {
  items: T[];
  meta: OffsetPaginationMeta;
}

// ── 4. Aggregate Root & Repository Port Contracts ───────────────────────────

export interface IBaseAggregate {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBaseRepository<T extends IBaseAggregate> {
  findById(workspaceId: string, id: string): Promise<T | null>;
  findMany(workspaceId: string, options?: unknown): Promise<T[]>;
  create(
    workspaceId: string,
    entity: Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'version'>,
  ): Promise<T>;
  update(
    workspaceId: string,
    id: string,
    expectedVersion: number,
    updates: Partial<T>,
  ): Promise<T>;
  delete(
    workspaceId: string,
    id: string,
    expectedVersion?: number,
  ): Promise<boolean>;
}

export interface IUnitOfWork {
  execute<R>(work: (transactionContext: unknown) => Promise<R>): Promise<R>;
}
