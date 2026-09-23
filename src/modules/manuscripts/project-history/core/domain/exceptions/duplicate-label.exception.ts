/**
 * project-history/core/domain/exceptions/duplicate-label.exception.ts
 * Domain Exception thrown when attempting to create a label that already exists in the project.
 */

export class DuplicateLabelException extends Error {
  constructor(public readonly projectId: string, public readonly label: string) {
    super(`Label '${label}' already exists in project '${projectId}'.`);
    this.name = 'DuplicateLabelException';
  }
}
