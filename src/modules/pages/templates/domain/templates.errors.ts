import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

export class InvalidTemplateException extends PagesDomainError {
  constructor(message: string) {
    super(`Invalid manuscript template: ${message}`, {
      code: 'INVALID_TEMPLATE',
      statusCode: 400,
    });
  }
}

export class TemplateNotFoundException extends PagesDomainError {
  constructor(templateIdentifier: string) {
    super(`Manuscript template not found: "${templateIdentifier}"`, {
      code: 'TEMPLATE_NOT_FOUND',
      statusCode: 404,
    });
  }
}
