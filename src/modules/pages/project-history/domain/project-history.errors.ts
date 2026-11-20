import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

/**
 * project-history/core/domain/exceptions/duplicate-label.exception.ts
 * Domain Exception thrown when attempting to create a label that already exists in the project.
 */

export class DuplicateLabelException extends PagesDomainError {
  constructor(
    public readonly projectId: string,
    public readonly label: string,
  ) {
    super(`Label '${label}' already exists in project '${projectId}'.`, {
      code: 'DUPLICATE_VERSION_LABEL',
      statusCode: 409,
    });
  }
}

/**
 * project-history/core/domain/exceptions/empty-project.exception.ts
 * Domain Exception thrown when attempting to snapshot a project with 0 files.
 */

export class EmptyProjectException extends PagesDomainError {
  constructor(public readonly projectId: string) {
    super(
      `Cannot create history snapshot for project '${projectId}' because it contains no files.`,
      {
        code: 'EMPTY_PAGE_SNAPSHOT',
        statusCode: 400,
      },
    );
  }
}

/**
 * project-history/core/domain/exceptions/version-not-found.exception.ts
 * Domain Exception thrown when a requested version snapshot does not exist in a project.
 */

export class VersionNotFoundException extends PagesDomainError {
  constructor(
    public readonly projectId: string,
    public readonly version: number,
  ) {
    super(
      `Version ${version} of project '${projectId}' was not found in history.`,
      {
        code: 'VERSION_NOT_FOUND',
        statusCode: 404,
      },
    );
  }
}

export class SnapshotFileNotFoundException extends PagesDomainError {
  constructor(
    public readonly pathname: string,
    public readonly version: number,
  ) {
    super(`File '${pathname}' was not found in version ${version} snapshot.`, {
      code: 'SNAPSHOT_FILE_NOT_FOUND',
      statusCode: 404,
    });
  }
}
