/**
 * realtime/core/domain/exceptions/unauthorized-project.exception.ts
 * Thrown when a user socket attempts to connect to or join a project without sufficient permissions.
 */

export class UnauthorizedProjectException extends Error {
  constructor(public readonly userId: string, public readonly projectId: string) {
    super(`User '${userId}' is not authorized to access manuscript project '${projectId}'.`);
    this.name = 'UnauthorizedProjectException';
  }
}
