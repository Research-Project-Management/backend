import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

export class InvalidLogFormatException extends PagesDomainError {
  constructor(message = 'The provided compilation log is empty or invalid') {
    super(message, {
      code: 'INVALID_COMPILE_LOG',
      statusCode: 400,
    });
  }
}
