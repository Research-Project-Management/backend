/**
 * templates/domain/errors.ts
 * Pure domain errors for Manuscripts Templates (zero framework imports).
 */

import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class InvalidTemplateError extends PagesDomainError {
  constructor(message: string) {
    super(message, { code: 'INVALID_TEMPLATE', statusCode: 400 });
  }
}

export class TemplateNotFoundError extends PagesDomainError {
  constructor(identifier: string) {
    super(`Template not found: "${identifier}"`, {
      code: 'TEMPLATE_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class TemplateForbiddenError extends PagesDomainError {
  constructor(message = 'You do not have permission to modify this template') {
    super(message, { code: 'TEMPLATE_FORBIDDEN', statusCode: 403 });
  }
}
