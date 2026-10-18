export class InvalidTemplateException extends Error {
  constructor(message: string) {
    super(`Invalid manuscript template: ${message}`);
    this.name = 'InvalidTemplateException';
  }
}
