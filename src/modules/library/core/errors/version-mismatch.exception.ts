import { HttpException, HttpStatus } from '@nestjs/common';

export interface VersionMismatchOptions {
  aggregateType?: string;
  entityId?: string;
  currentVersion?: number;
  providedVersion?: number;
  expectedVersion?: number;
  message?: string;
}

export class VersionMismatchException extends HttpException {
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

    if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
      currentVer = messageOrOptions.currentVersion ?? currentVer;
      expectedVer =
        messageOrOptions.providedVersion ??
        messageOrOptions.expectedVersion ??
        expectedVer;
      message =
        messageOrOptions.message ||
        `Version conflict on ${messageOrOptions.aggregateType || 'entity'} (${messageOrOptions.entityId || 'unknown'}): current version is ${currentVer}, expected ${expectedVer}`;
    } else if (typeof messageOrOptions === 'string') {
      message = messageOrOptions;
    }

    super(
      {
        statusCode: HttpStatus.PRECONDITION_FAILED,
        error: 'Precondition Failed',
        message,
        code: 'VERSION_MISMATCH',
        currentVersion: currentVer,
        expectedVersion: expectedVer,
      },
      HttpStatus.PRECONDITION_FAILED,
    );
    this.currentVersion = currentVer;
    this.expectedVersion = expectedVer;
  }
}
