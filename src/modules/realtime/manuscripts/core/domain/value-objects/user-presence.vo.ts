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

export interface UserPresenceJSON {
  userId: string;
  socketId: string;
  name: string;
  color: string;
  avatar: string | null;
  activeDocId: string | null;
  cursor: ReturnType<CursorPositionVo['toJSON']> | null;
  lastSeenAt: string;
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

  public toJSON(): UserPresenceJSON {
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

  public static fromJSON(raw: unknown): UserPresenceVo {
    if (!raw || typeof raw !== 'object') {
      throw new Error(
        'Cannot construct UserPresenceVo from null or non-object',
      );
    }
    const r = raw as Record<string, unknown>;
    let cursor: CursorPositionVo | null = null;
    if (r.cursor && typeof r.cursor === 'object') {
      const c = r.cursor as Record<string, unknown>;
      cursor = CursorPositionVo.create({
        row: Number(c.row) || 0,
        column: Number(c.column) || 0,
        selection:
          (c.selection as Parameters<
            typeof CursorPositionVo.create
          >[0]['selection']) ?? null,
      });
    }
    return new UserPresenceVo({
      userId: String(r.userId || ''),
      socketId: String(r.socketId || ''),
      name: String(r.name || 'Anonymous Collaborator'),
      color: String(r.color || '#3b82f6'),
      avatar: typeof r.avatar === 'string' ? r.avatar : null,
      activeDocId: typeof r.activeDocId === 'string' ? r.activeDocId : null,
      cursor,
      lastSeenAt: r.lastSeenAt ? new Date(String(r.lastSeenAt)) : new Date(),
    });
  }
}
