import { ConflictException } from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  Min,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Standard mutation headers supplied in HTTP request headers.
 */
export class MutationHeadersDto {
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ifMatchVersion?: number;

  @IsOptional()
  @IsDateString()
  clientTimestamp?: string;

  @IsOptional()
  @IsString()
  origin?: string;
}

/**
 * DTO mixin for optimistic locking on mutation requests.
 */
export class OptimisticLockingDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/**
 * DTO mixin for idempotent request payload tracking.
 */
export class IdempotentMutationDto {
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

/**
 * Structured concurrency conflict error payload.
 */
export interface ConcurrencyConflictPayload {
  entityId: string;
  aggregateType: string;
  currentVersion: number;
  providedVersion: number;
  message?: string;
}

/**
 * Domain exception thrown when an optimistic concurrency check fails.
 * Produces HTTP 409 Conflict with standard error envelope.
 */
export class VersionMismatchException extends ConflictException {
  public readonly conflictDetails: ConcurrencyConflictPayload;

  constructor(details: ConcurrencyConflictPayload) {
    super({
      success: false,
      error: {
        code: 'VERSION_MISMATCH',
        message:
          details.message ||
          `Version mismatch on ${details.aggregateType} ${details.entityId}: provided version ${details.providedVersion}, current version is ${details.currentVersion}.`,
        details: {
          entityId: details.entityId,
          aggregateType: details.aggregateType,
          currentVersion: details.currentVersion,
          providedVersion: details.providedVersion,
        },
      },
    });
    this.conflictDetails = details;
  }
}
