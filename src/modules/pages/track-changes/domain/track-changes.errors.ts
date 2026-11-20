import { PagesDomainError } from '@/modules/pages/core/domain/pages-domain.error';

/**
 * track-changes/core/domain/exceptions/change-not-found.exception.ts
 * Thrown when a targeted track change mutation ID does not exist in the project or document.
 */

export class ChangeNotFoundException extends PagesDomainError {
  constructor(public readonly changeId: string) {
    super(`Track change '${changeId}' was not found.`, {
      code: 'TRACK_CHANGE_NOT_FOUND',
      statusCode: 404,
    });
  }
}

/**
 * track-changes/core/domain/exceptions/stale-anchor.exception.ts
 * Thrown when a track change's target text no longer matches its recorded line/column coordinates.
 */

export class StaleTrackChangeAnchorException extends PagesDomainError {
  constructor(public readonly changeId: string) {
    super(
      `Track change '${changeId}' can no longer be applied cleanly because the surrounding text was modified.`,
      {
        code: 'STALE_TRACK_CHANGE_ANCHOR',
        statusCode: 409,
      },
    );
  }
}

/**
 * track-changes/core/domain/exceptions/resolved-thread.exception.ts
 * Thrown when trying to reply to or modify a comment thread that has already been resolved.
 */

export class ResolvedThreadException extends PagesDomainError {
  constructor(public readonly threadId: string) {
    super(
      `Cannot reply or mutate comment thread '${threadId}' because it has already been resolved.`,
      {
        code: 'COMMENT_THREAD_RESOLVED',
        statusCode: 409,
      },
    );
  }
}

/**
 * track-changes/core/domain/exceptions/thread-not-found.exception.ts
 * Thrown when a targeted comment thread ID does not exist in the project or document.
 */

export class ThreadNotFoundException extends PagesDomainError {
  constructor(public readonly threadId: string) {
    super(`Comment thread '${threadId}' was not found.`, {
      code: 'COMMENT_THREAD_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class TrackChangePatchConflictException extends PagesDomainError {
  constructor(public readonly docId: string) {
    super(`Failed to patch document ${docId} after retries.`, {
      code: 'TRACK_CHANGE_PATCH_CONFLICT',
      statusCode: 409,
    });
  }
}
