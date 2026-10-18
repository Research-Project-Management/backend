export class DocumentLockedException extends Error {
  constructor(
    public readonly targetId: string,
    public readonly lockReason = 'Document is currently being flushed to persistent storage.',
  ) {
    super(`Resource '${targetId}' is locked: ${lockReason}`);
    this.name = 'DocumentLockedException';
  }
}
