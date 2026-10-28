import { HttpStatus } from '@nestjs/common';
import { BaseDomainException } from './domain.exception';

export { BaseDomainException };
export { VersionMismatchException as OptimisticLockException };


export interface VersionMismatchOptions {
  aggregateType?: string;
  entityId?: string;
  currentVersion?: number;
  providedVersion?: number;
  expectedVersion?: number;
  message?: string;
}

export class VersionMismatchException extends BaseDomainException {
  override readonly code = 'VERSION_MISMATCH';
  public readonly statusCode = HttpStatus.PRECONDITION_FAILED;
  public readonly currentVersion?: number;
  public readonly expectedVersion?: number;

  constructor(
    messageOrOptions?: string | VersionMismatchOptions,
    currentVersion?: number,
    expectedVersion?: number,
  ) {
    let message =
      'The item has been modified by another process. Please reload and try again.';
    let currentVer = currentVersion;
    let expectedVer = expectedVersion;
    let aggregateType: string | undefined;
    let entityId: string | undefined;

    if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
      aggregateType = messageOrOptions.aggregateType;
      entityId = messageOrOptions.entityId;
      currentVer = messageOrOptions.currentVersion ?? currentVer;
      expectedVer =
        messageOrOptions.providedVersion ??
        messageOrOptions.expectedVersion ??
        expectedVer;
      message =
        messageOrOptions.message ||
        `Version conflict on ${aggregateType || 'entity'} (${entityId || 'unknown'}): current version is ${currentVer}, expected ${expectedVer}`;
    } else if (typeof messageOrOptions === 'string') {
      message = messageOrOptions;
    }

    super(message, {
      statusCode: HttpStatus.PRECONDITION_FAILED,
      error: 'Precondition Failed',
      code: 'VERSION_MISMATCH',
      ...(aggregateType ? { aggregateType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(currentVer !== undefined ? { currentVersion: currentVer } : {}),
      ...(expectedVer !== undefined ? { expectedVersion: expectedVer } : {}),
    });

    this.currentVersion = currentVer;
    this.expectedVersion = expectedVer;
  }

  getStatus(): number {
    return this.statusCode;
  }

  getResponse(): Record<string, unknown> {
    return {
      statusCode: this.statusCode,
      error: 'Precondition Failed',
      message: this.message,
      code: this.code,
      currentVersion: this.currentVersion,
      expectedVersion: this.expectedVersion,
    };
  }
}
