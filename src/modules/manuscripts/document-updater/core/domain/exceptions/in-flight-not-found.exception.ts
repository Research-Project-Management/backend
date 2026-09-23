/**
 * document-updater/core/domain/exceptions/in-flight-not-found.exception.ts
 * Domain Exception thrown when an in-flight document buffer is expected but does not exist in memory/Redis.
 */

export class InFlightNotFoundException extends Error {
  constructor(public readonly docId: string, public readonly projectId?: string) {
    super(
      `In-flight document '${docId}' ${projectId ? `in project '${projectId}' ` : ''}is not active in memory buffer.`,
    );
    this.name = 'InFlightNotFoundException';
  }
}
