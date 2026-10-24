/**
 * project-history/core/domain/exceptions/duplicate-label.exception.ts
 * Domain Exception thrown when attempting to create a label that already exists in the project.
 */

export class DuplicateLabelException extends Error {
  constructor(
    public readonly projectId: string,
    public readonly label: string,
  ) {
    super(`Label '${label}' already exists in project '${projectId}'.`);
    this.name = 'DuplicateLabelException';
  }
}

/**
 * project-history/core/domain/exceptions/empty-project.exception.ts
 * Domain Exception thrown when attempting to snapshot a project with 0 files.
 */

export class EmptyProjectException extends Error {
  constructor(public readonly projectId: string) {
    super(
      `Cannot create history snapshot for project '${projectId}' because it contains no files.`,
    );
    this.name = 'EmptyProjectException';
  }
}

/**
 * project-history/core/domain/exceptions/version-not-found.exception.ts
 * Domain Exception thrown when a requested version snapshot does not exist in a project.
 */

export class VersionNotFoundException extends Error {
  constructor(
    public readonly projectId: string,
    public readonly version: number,
  ) {
    super(
      `Version ${version} of project '${projectId}' was not found in history.`,
    );
    this.name = 'VersionNotFoundException';
  }
}
