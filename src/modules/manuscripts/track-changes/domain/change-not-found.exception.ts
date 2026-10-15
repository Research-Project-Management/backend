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
