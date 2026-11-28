import { PagesDomainError } from '@/modules/pages/core/domain/errors';

export class ChangeNotFoundError extends PagesDomainError {
  constructor(public readonly changeId: string) {
    super(`Track change '${changeId}' was not found.`, {
      code: 'TRACK_CHANGE_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class StaleAnchorError extends PagesDomainError {
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

export class PatchConflictError extends PagesDomainError {
  constructor(public readonly docId: string) {
    super(`Failed to patch document ${docId} after retries.`, {
      code: 'TRACK_CHANGE_PATCH_CONFLICT',
      statusCode: 409,
    });
  }
}

export class InvalidChangeError extends PagesDomainError {
  constructor(message: string) {
    super(message, {
      code: 'INVALID_TRACK_CHANGE',
      statusCode: 400,
    });
  }
}

export class ThreadNotFoundError extends PagesDomainError {
  constructor(public readonly threadId: string) {
    super(`Comment thread '${threadId}' was not found.`, {
      code: 'COMMENT_THREAD_NOT_FOUND',
      statusCode: 404,
    });
  }
}

export class ResolvedThreadError extends PagesDomainError {
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

export class InvalidThreadError extends PagesDomainError {
  constructor(message: string) {
    super(message, {
      code: 'INVALID_COMMENT_THREAD',
      statusCode: 400,
    });
  }
}

export class InvalidReplyError extends PagesDomainError {
  constructor(message = 'Reply content cannot be empty.') {
    super(message, {
      code: 'INVALID_COMMENT_REPLY',
      statusCode: 400,
    });
  }
}
