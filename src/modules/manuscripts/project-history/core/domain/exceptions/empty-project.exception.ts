/**
 * project-history/core/domain/exceptions/empty-project.exception.ts
 * Domain Exception thrown when attempting to snapshot a project with 0 files.
 */

export class EmptyProjectException extends Error {
  constructor(public readonly projectId: string) {
    super(`Cannot create history snapshot for project '${projectId}' because it contains no files.`);
    this.name = 'EmptyProjectException';
  }
}
