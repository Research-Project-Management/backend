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
