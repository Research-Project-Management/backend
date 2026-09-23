export class TemplateNotFoundException extends Error {
  constructor(templateIdentifier: string) {
    super(`Manuscript template not found: "${templateIdentifier}"`);
    this.name = 'TemplateNotFoundException';
  }
}
