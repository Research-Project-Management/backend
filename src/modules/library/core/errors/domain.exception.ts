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
