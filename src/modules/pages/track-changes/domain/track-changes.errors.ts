/**
 * track-changes/core/domain/exceptions/change-not-found.exception.ts
 * Thrown when a targeted track change mutation ID does not exist in the project or document.
 */

export class ChangeNotFoundException extends Error {
  constructor(public readonly changeId: string) {
    super(`Track change '${changeId}' was not found.`);
    this.name = 'ChangeNotFoundException';
  }
}

/**
 * track-changes/core/domain/exceptions/resolved-thread.exception.ts
 * Thrown when trying to reply to or modify a comment thread that has already been resolved.
 */

export class ResolvedThreadException extends Error {
  constructor(public readonly threadId: string) {
    super(
      `Cannot reply or mutate comment thread '${threadId}' because it has already been resolved.`,
    );
    this.name = 'ResolvedThreadException';
  }
}

/**
 * track-changes/core/domain/exceptions/thread-not-found.exception.ts
 * Thrown when a targeted comment thread ID does not exist in the project or document.
 */

export class ThreadNotFoundException extends Error {
  constructor(public readonly threadId: string) {
    super(`Comment thread '${threadId}' was not found.`);
    this.name = 'ThreadNotFoundException';
  }
}
