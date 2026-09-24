/**
 * realtime/core/use-cases/leave-project.use-case.ts
 * Inbound Use Case handling user disconnection or exit from a project collaboration room.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../ports/room-manager.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';

export interface LeaveProjectInput {
  projectId: string;
  socketId: string;
}

@Injectable()
export class LeaveProjectUseCase {
  constructor(
    private readonly roomManager: IRoomManagerPort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
  ) {}

  public async execute(input: LeaveProjectInput): Promise<void> {
    const { projectId, socketId } = input;

    const removedSession = await this.roomManager.removeProjectSession(projectId, socketId);
    if (!removedSession) {
      return;
    }

    // Broadcast user exit from project room
    this.broadcaster.broadcastToProject(projectId, 'project:user-left', {
      userId: removedSession.userId,
      socketId,
    });

    // If user was viewing a specific doc, also notify the doc room
    if (removedSession.activeDocId) {
      this.broadcaster.broadcastToDoc(projectId, removedSession.activeDocId, 'doc:user-left', {
        userId: removedSession.userId,
        socketId,
      });
    }
  }
}
