/**
 * export-import/core/domain/exceptions/template-not-found.exception.ts
 * Domain exception thrown when the requested project template is not found in the catalog.
 */

export class TemplateNotFoundException extends Error {
  constructor(templateId: string) {
    super(`Manuscript project template '${templateId}' was not found in catalog.`);
    this.name = 'TemplateNotFoundException';
  }
}
