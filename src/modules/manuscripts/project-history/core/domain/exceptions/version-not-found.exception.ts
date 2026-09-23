/**
 * project-history/core/domain/exceptions/version-not-found.exception.ts
 * Domain Exception thrown when a requested version snapshot does not exist in a project.
 */

export class VersionNotFoundException extends Error {
  constructor(public readonly projectId: string, public readonly version: number) {
    super(`Version ${version} of project '${projectId}' was not found in history.`);
    this.name = 'VersionNotFoundException';
  }
}
