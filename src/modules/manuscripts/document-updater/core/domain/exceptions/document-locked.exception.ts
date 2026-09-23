/**
 * document-updater/core/domain/exceptions/document-locked.exception.ts
 * Domain Exception thrown when an update cannot proceed because the document or project is currently locked for flushing or compilation.
 */

export class DocumentLockedException extends Error {
  constructor(public readonly targetId: string, public readonly lockReason = 'Document is currently being flushed to persistent storage.') {
    super(`Resource '${targetId}' is locked: ${lockReason}`);
    this.name = 'DocumentLockedException';
  }
}
