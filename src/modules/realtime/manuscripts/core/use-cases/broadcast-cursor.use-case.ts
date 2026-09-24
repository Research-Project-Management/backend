/**
 * realtime/core/use-cases/broadcast-cursor.use-case.ts
 * Inbound Use Case tracking and broadcasting cursor and text selection coordinates to document peers.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../ports/room-manager.port';
import { IRealtimeBroadcasterPort } from '../ports/realtime-broadcaster.port';
import { CursorPositionVo, CursorPositionProps } from '../domain/value-objects/cursor-position.vo';
import { UserPresenceVo } from '../domain/value-objects/user-presence.vo';

export interface BroadcastCursorInput {
  projectId: string;
  docId: string;
  socketId: string;
  cursor: CursorPositionProps;
}

@Injectable()
export class BroadcastCursorUseCase {
  constructor(
    private readonly roomManager: IRoomManagerPort,
    private readonly broadcaster: IRealtimeBroadcasterPort,
  ) {}

  public async execute(input: BroadcastCursorInput): Promise<UserPresenceVo | null> {
    const { projectId, docId, socketId, cursor } = input;

    const cursorVo = CursorPositionVo.create(cursor);
    const updatedPresence = await this.roomManager.updateSessionCursor(
      projectId,
      docId,
      socketId,
      cursorVo,
    );

    if (updatedPresence) {
      this.broadcaster.broadcastToDoc(
        projectId,
        docId,
        'doc:cursor',
        updatedPresence.toJSON(),
        socketId,
      );
    }

    return updatedPresence;
  }
}
