export class InFlightNotFoundException extends Error {
  constructor(
    public readonly docId: string,
    public readonly projectId?: string,
  ) {
    super(
      `In-flight document '${docId}' ${projectId ? `in project '${projectId}' ` : ''}is not active in memory buffer.`,
    );
    this.name = 'InFlightNotFoundException';
  }
}
