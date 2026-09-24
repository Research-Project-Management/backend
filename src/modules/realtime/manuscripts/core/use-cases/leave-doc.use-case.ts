/**
 * realtime/core/use-cases/leave-doc.use-case.ts
 * Inbound Use Case handling user closing or switching away from a document editor.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../ports/room-manager.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';

export interface LeaveDocInput {
  projectId: string;
  docId: string;
  socketId: string;
}

@Injectable()
export class LeaveDocUseCase {
  constructor(
    private readonly roomManager: IRoomManagerPort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
  ) {}

  public async execute(input: LeaveDocInput): Promise<void> {
    const { projectId, docId, socketId } = input;

    const session = await this.roomManager.getSession(socketId);
    await this.roomManager.leaveDocRoom(projectId, docId, socketId);

    // Notify peers that user has left the doc editor
    this.broadcaster.broadcastToDoc(projectId, docId, 'doc:user-left', {
      userId: session?.userId,
      socketId,
    });
  }
}
