/**
 * realtime/core/ports/room-manager.port.ts
 * Outbound Port (SPI) for managing collaborative project and document rooms and user presence state.
 */

import { PresenceSession } from '../domain/entities/presence-session.entity';
import { UserPresenceVo } from '../domain/value-objects/user-presence.vo';
import { CursorPositionVo } from '../domain/value-objects/cursor-position.vo';

export abstract class IRoomManagerPort {
  /**
   * Registers a connected socket session into a project room.
   */
  abstract addProjectSession(session: PresenceSession): Promise<void>;

  /**
   * Removes a socket session from a project and any document room it was active in.
   */
  abstract removeProjectSession(projectId: string, socketId: string): Promise<PresenceSession | null>;

  /**
   * Returns all active user presence records in a project.
   */
  abstract getProjectSessions(projectId: string): Promise<UserPresenceVo[]>;

  /**
   * Switches an active user socket to collaborate on a specific document inside the project.
   */
  abstract joinDocRoom(projectId: string, docId: string, socketId: string): Promise<UserPresenceVo[]>;

  /**
   * Removes a socket from collaborating on a document room.
   */
  abstract leaveDocRoom(projectId: string, docId: string, socketId: string): Promise<void>;

  /**
   * Returns all active user presence records currently viewing/editing a specific document.
   */
  abstract getDocSessions(projectId: string, docId: string): Promise<UserPresenceVo[]>;

  /**
   * Updates real-time cursor/selection position for a collaborator.
   */
  abstract updateSessionCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPositionVo,
  ): Promise<UserPresenceVo | null>;

  /**
   * Look up an active session by socket ID.
   */
  abstract getSession(socketId: string): Promise<PresenceSession | null>;
}
