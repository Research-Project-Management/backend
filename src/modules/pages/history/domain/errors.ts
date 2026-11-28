import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class DuplicateLabelException extends PagesDomainError {
  constructor(
    public readonly spaceId: string,
    public readonly label: string,
  ) {
    super(`Label '${label}' already exists in space '${spaceId}'.`, {
      code: 'DUPLICATE_VERSION_LABEL',
      statusCode: 409,
    });
  }
}

export class EmptyProjectException extends PagesDomainError {
  constructor(public readonly spaceId: string) {
    super(
      `Cannot create history snapshot for space '${spaceId}' because it contains no files.`,
      {
        code: 'EMPTY_PAGE_SNAPSHOT',
        statusCode: 400,
      },
    );
  }
}

export class VersionNotFoundException extends PagesDomainError {
  constructor(
    public readonly spaceId: string,
    public readonly version: number,
  ) {
    super(
      `Version ${version} of space '${spaceId}' was not found in history.`,
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
