/**
 * Shared domain error base class for the Pages (`modules/pages`) bounded context.
 *
 * Intentionally zero external framework dependencies (no `@nestjs/*`, no `@prisma/*`)
 * so standalone build targets such as `tsconfig.clsi.json` can import it directly
 * without pulling runtime NestJS/Prisma modules into slim worker images.
 */

export interface PagesDomainErrorOptions {
  code: string;
  statusCode: number;
  details?: unknown;
  internalReason?: string;
  cause?: unknown;
}

export class PagesDomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly httpStatus: number;
  public readonly details?: unknown;
  public readonly internalReason?: string;

  constructor(message: string, options: PagesDomainErrorOptions) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.httpStatus = options.statusCode;
    if (options.details !== undefined) {
      this.details = options.details;
    }
    if (options.internalReason !== undefined) {
      this.internalReason = options.internalReason;
    }
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
    Error.captureStackTrace?.(this, new.target);
  }
}

export class PagesServiceUnavailableError extends PagesDomainError {
  constructor(
    message = 'Pages service dependency is not available',
    details?: unknown,
  ) {
    super(message, {
      code: 'PAGES_SERVICE_UNAVAILABLE',
      statusCode: 503,
      details,
    });
  }
}

export class DistributedLockTimeoutError extends PagesDomainError {
  public readonly resource: string;
  public readonly maxWaitMs: number;

  constructor(resource: string, maxWaitMs: number) {
    super(
      `Failed to acquire distributed lock for resource "${resource}" within ${maxWaitMs}ms`,
      {
        code: 'DISTRIBUTED_LOCK_TIMEOUT',
        statusCode: 409,
        details: { resource, maxWaitMs },
      },
    );
    this.resource = resource;
    this.maxWaitMs = maxWaitMs;
  }
}
