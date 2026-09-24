/**
 * realtime/core/use-cases/join-doc.use-case.ts
 * Inbound Use Case handling user opening a specific document editor within the project.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../ports/room-manager.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';
import { UserPresenceVo } from '../domain/value-objects/user-presence.vo';
import { InvalidRoomException } from '../domain/exceptions/invalid-room.exception';

export interface JoinDocInput {
  projectId: string;
  docId: string;
  socketId: string;
}

export interface JoinDocOutput {
  docPresence: UserPresenceVo[];
}

@Injectable()
export class JoinDocUseCase {
  constructor(
    private readonly roomManager: IRoomManagerPort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
  ) {}

  public async execute(input: JoinDocInput): Promise<JoinDocOutput> {
    const { projectId, docId, socketId } = input;

    const session = await this.roomManager.getSession(socketId);
    if (!session) {
      throw new InvalidRoomException(projectId, `Session for socket '${socketId}' not found.`);
    }

    // Join doc room and retrieve active presence
    const docPresence = await this.roomManager.joinDocRoom(projectId, docId, socketId);

    // Notify other peers in this document
    this.broadcaster.broadcastToDoc(
      projectId,
      docId,
      'doc:user-joined',
      session.toPresenceVo().toJSON(),
      socketId,
    );

    return { docPresence };
  }
}
