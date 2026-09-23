/**
 * realtime/core/use-cases/join-project.use-case.ts
 * Inbound Use Case handling user connection to a manuscript project collaboration room.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../ports/room-manager.port';
import { IProjectAccessVerifierPort, ProjectAccessResult } from '../ports/project-access-verifier.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';
import { PresenceSession } from '../domain/entities/presence-session.entity';
import { UserPresenceVo } from '../domain/value-objects/user-presence.vo';
import { UnauthorizedProjectException } from '../domain/exceptions/unauthorized-project.exception';

export interface JoinProjectInput {
  projectId: string;
  userId: string;
  socketId: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
}

export interface JoinProjectOutput {
  session: PresenceSession;
  projectPresence: UserPresenceVo[];
  access: ProjectAccessResult;
}

@Injectable()
export class JoinProjectUseCase {
  constructor(
    private readonly roomManager: IRoomManagerPort,
    private readonly accessVerifier: IProjectAccessVerifierPort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
  ) {}

  public async execute(input: JoinProjectInput): Promise<JoinProjectOutput> {
    const { projectId, userId, socketId, name, color, avatar } = input;

    // 1. Verify user has at least read permission
    const access = await this.accessVerifier.verifyProjectAccess(userId, projectId);
    if (!access.canRead) {
      throw new UnauthorizedProjectException(userId, projectId);
    }

    // 2. Create presence session
    const session = PresenceSession.create({
      userId,
      socketId,
      projectId,
      name,
      color,
      avatar,
    });

    // 3. Register session in room manager
    await this.roomManager.addProjectSession(session);

    // 4. Retrieve all current active collaborators
    const projectPresence = await this.roomManager.getProjectSessions(projectId);

    // 5. Broadcast to existing collaborators in the project
    this.broadcaster.broadcastToProject(
      projectId,
      'project:user-joined',
      session.toPresenceVo().toJSON(),
      socketId,
    );

    return {
      session,
      projectPresence,
      access,
    };
  }
}
