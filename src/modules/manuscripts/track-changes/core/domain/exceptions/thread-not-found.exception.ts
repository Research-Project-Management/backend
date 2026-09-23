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
