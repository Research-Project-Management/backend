/**
 * realtime/core/domain/value-objects/user-presence.vo.ts
 * Value Object snapshot of user presence transmitted over WebSocket to other collaborators.
 */

import { CursorPositionVo } from './cursor-position.vo';

export interface UserPresenceProps {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar?: string | null;
  activeDocId?: string | null;
  cursor?: CursorPositionVo | null;
  lastSeenAt?: Date;
}

export class UserPresenceVo {
  public readonly userId: string;
  public readonly socketId: string;
  public readonly name: string;
  public readonly color: string;
  public readonly avatar: string | null;
  public readonly activeDocId: string | null;
  public readonly cursor: CursorPositionVo | null;
  public readonly lastSeenAt: Date;

  constructor(props: UserPresenceProps) {
    this.userId = props.userId;
    this.socketId = props.socketId;
    this.name = props.name || 'Anonymous Collaborator';
    this.color = props.color || '#3b82f6';
    this.avatar = props.avatar ?? null;
    this.activeDocId = props.activeDocId ?? null;
    this.cursor = props.cursor ?? null;
    this.lastSeenAt = props.lastSeenAt ?? new Date();
  }

  public toJSON(): Record<string, any> {
    return {
      userId: this.userId,
      socketId: this.socketId,
      name: this.name,
      color: this.color,
      avatar: this.avatar,
      activeDocId: this.activeDocId,
      cursor: this.cursor ? this.cursor.toJSON() : null,
      lastSeenAt: this.lastSeenAt.toISOString(),
    };
  }
}
