export class InvalidTemplateException extends Error {
  public readonly statusCode = 400;

  constructor(message: string) {
    super(`Invalid manuscript template: ${message}`);
    this.name = 'InvalidTemplateException';
  }
}

export class TemplateNotFoundException extends Error {
  public readonly statusCode = 404;

  constructor(templateIdentifier: string) {
    super(`Manuscript template not found: "${templateIdentifier}"`);
    this.name = 'TemplateNotFoundException';
  }
}
