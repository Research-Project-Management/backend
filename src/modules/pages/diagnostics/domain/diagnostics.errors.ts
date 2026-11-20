import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

/**
 * diagnostics/core/domain/exceptions/explanation-not-found.exception.ts
 * Thrown when an explanation for a requested error code cannot be found in the knowledge base.
 */

export class ExplanationNotFoundException extends PagesDomainError {
  constructor(public readonly errorCode: string) {
    super(
      `No explanation found in knowledge base for error code: '${errorCode}'`,
      {
        code: 'DIAGNOSTIC_EXPLANATION_NOT_FOUND',
        statusCode: 404,
      },
    );
  }
}

/**
 * diagnostics/core/domain/exceptions/invalid-log-format.exception.ts
 * Thrown when raw log content is empty or unparsable.
 */

export class InvalidLogFormatException extends PagesDomainError {
  constructor(message = 'The provided compilation log is empty or invalid') {
    super(message, {
      code: 'INVALID_COMPILE_LOG',
      statusCode: 400,
    });
  }
}
