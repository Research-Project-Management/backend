export class InvalidTemplateException extends Error {
  constructor(message: string) {
    super(`Invalid manuscript template: ${message}`);
    this.name = 'InvalidTemplateException';
  }
}

export class TemplateNotFoundException extends Error {
  constructor(templateIdentifier: string) {
    super(`Manuscript template not found: "${templateIdentifier}"`);
    this.name = 'TemplateNotFoundException';
  }
}
