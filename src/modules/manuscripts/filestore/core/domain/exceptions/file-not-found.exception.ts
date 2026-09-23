/**
 * filestore/core/domain/exceptions/file-not-found.exception.ts
 */

export class FileNotFoundException extends Error {
  constructor(public readonly fileId: string, public readonly projectId?: string) {
    super(`Manuscript file '${fileId}' was not found in project '${projectId ?? 'unknown'}'.`);
    this.name = 'FileNotFoundException';
  }
}
