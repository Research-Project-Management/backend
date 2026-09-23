/**
 * realtime/core/ports/project-access-verifier.port.ts
 * Outbound Port (SPI) for verifying user read/write authorization for a manuscript project.
 */

export interface ProjectAccessResult {
  canRead: boolean;
  canWrite: boolean;
  role: string;
}

export abstract class IProjectAccessVerifierPort {
  abstract verifyProjectAccess(userId: string, projectId: string): Promise<ProjectAccessResult>;
}
