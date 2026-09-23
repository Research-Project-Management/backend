/**
 * filestore/core/domain/exceptions/duplicate-file.exception.ts
 */

export class DuplicateFileException extends Error {
  constructor(public readonly filename: string, public readonly projectId: string) {
    super(`A file with name '${filename}' already exists in project '${projectId}'.`);
    this.name = 'DuplicateFileException';
  }
}
