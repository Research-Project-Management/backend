/**
 * realtime/core/domain/exceptions/stale-client-rev.exception.ts
 * Thrown when an update operation sent by a client has a stale client revision.
 */

export class StaleClientRevException extends Error {
  constructor(
    public readonly docId: string,
    public readonly clientRev: number,
    public readonly serverRev: number,
  ) {
    super(
      `Stale revision for doc '${docId}': Client revision ${clientRev} is behind server revision ${serverRev}.`,
    );
    this.name = 'StaleClientRevException';
  }
}
