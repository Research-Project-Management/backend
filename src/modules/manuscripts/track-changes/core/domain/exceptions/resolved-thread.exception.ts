/**
 * track-changes/core/domain/exceptions/resolved-thread.exception.ts
 * Thrown when trying to reply to or modify a comment thread that has already been resolved.
 */

export class ResolvedThreadException extends Error {
  constructor(public readonly threadId: string) {
    super(`Cannot reply or mutate comment thread '${threadId}' because it has already been resolved.`);
    this.name = 'ResolvedThreadException';
  }
}
