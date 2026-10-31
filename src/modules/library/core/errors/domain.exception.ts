import { HttpStatus } from '@nestjs/common';

/**
 * Universal Base Domain Exception for all Bounded Contexts in the Library module.
 *
 * Clean Architecture & DDD Core Policy:
 * Shared Kernel provides the base exception abstraction so that infrastructure filters
 * can handle domain errors without importing child context domain exceptions.
 */
export abstract class BaseDomainException extends Error {
  readonly code: string = 'LIBRARY_DOMAIN_ERROR';
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.details = details;
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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

export { VersionMismatchException as OptimisticLockException };

/**
 * Thrown when an illegal state transition is attempted on an IngestionRun, Item, or Attachment aggregate.
 */
export class InvalidStateTransitionException extends BaseDomainException {
  override readonly code = 'LIBRARY_INVALID_STATE_TRANSITION';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an external academic provider (Crossref, OpenAlex, PubMed, Unpaywall, etc.) fails or returns invalid data.
 */
export class ExternalProviderException extends BaseDomainException {
  override readonly code = 'LIBRARY_EXTERNAL_PROVIDER_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when extraction (PDF parsing, OCR, layout heuristics, or web snapshots) encounters an unrecoverable error.
 */
export class ExtractionProcessException extends BaseDomainException {
  override readonly code = 'LIBRARY_EXTRACTION_PROCESS_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an internal library subsystem or worker pool is unavailable.
 */
export class SubsystemUnavailableException extends BaseDomainException {
  override readonly code = 'LIBRARY_SUBSYSTEM_UNAVAILABLE';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when an entity (item, attachment, note, collection, tag) is not found.
 */
export class EntityNotFoundException extends BaseDomainException {
  override readonly code = 'LIBRARY_ENTITY_NOT_FOUND';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Thrown when system configuration, database client, or transaction context is missing or invalid.
 */
export class ConfigurationException extends BaseDomainException {
  override readonly code = 'LIBRARY_CONFIGURATION_ERROR';

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}
