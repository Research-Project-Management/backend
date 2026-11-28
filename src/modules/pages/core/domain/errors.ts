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

export class StructureError extends PagesDomainError {
  constructor(message: string, httpStatus = 400, code = 'STRUCTURE_ERROR') {
    super(message, {
      code,
      statusCode: httpStatus,
    });
  }
}

export class InvalidNodeNameError extends StructureError {
  constructor(name: string, reason?: string) {
    super(
      `Invalid node name '${name}'${reason ? `: ${reason}` : ''}`,
      400,
      'STRUCTURE_INVALID_NODE_NAME',
    );
  }
}
