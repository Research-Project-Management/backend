/**
 * document-updater/core/domain/exceptions/doc-updater-conflict.exception.ts
 * Domain Exception thrown when an OCC revision conflict occurs during flush or state reconciliation.
 */

export class DocUpdaterConflictException extends Error {
  constructor(
    public readonly docId: string,
    public readonly expectedRev: number,
    public readonly actualRev: number,
  ) {
    super(
      `Conflict on doc '${docId}': Expected revision ${expectedRev}, but found revision ${actualRev} in persistent storage.`,
    );
    this.name = 'DocUpdaterConflictException';
  }
}
