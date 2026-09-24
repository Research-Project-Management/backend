/**
 * realtime/core/domain/entities/presence-session.entity.ts
 * Domain Entity representing an active WebSocket presence session of a collaborator.
 */

import { CursorPositionVo } from '../value-objects/cursor-position.vo';
import { UserPresenceVo } from '../value-objects/user-presence.vo';

export interface PresenceSessionProps {
  userId: string;
  socketId: string;
  projectId: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
  activeDocId?: string | null;
  cursor?: CursorPositionVo | null;
  connectedAt?: Date;
  lastSeenAt?: Date;
}

export class PresenceSession {
  private readonly _userId: string;
  private readonly _socketId: string;
  private readonly _projectId: string;
  private readonly _name: string;
  private readonly _color: string;
  private readonly _avatar: string | null;
  private _activeDocId: string | null;
  private _cursor: CursorPositionVo | null;
  private readonly _connectedAt: Date;
  private _lastSeenAt: Date;

  private constructor(props: PresenceSessionProps) {
    this._userId = props.userId;
    this._socketId = props.socketId;
    this._projectId = props.projectId;
    this._name = props.name || 'Anonymous Collaborator';
    this._color = props.color || PresenceSession.generateColor(props.userId);
    this._avatar = props.avatar ?? null;
    this._activeDocId = props.activeDocId ?? null;
    this._cursor = props.cursor ?? null;
    this._connectedAt = props.connectedAt ?? new Date();
    this._lastSeenAt = props.lastSeenAt ?? new Date();
  }

  public static create(props: PresenceSessionProps): PresenceSession {
    return new PresenceSession(props);
  }

  public get userId(): string { return this._userId; }
  public get socketId(): string { return this._socketId; }
  public get projectId(): string { return this._projectId; }
  public get name(): string { return this._name; }
  public get color(): string { return this._color; }
  public get avatar(): string | null { return this._avatar; }
  public get activeDocId(): string | null { return this._activeDocId; }
  public get cursor(): CursorPositionVo | null { return this._cursor; }
  public get connectedAt(): Date { return this._connectedAt; }
  public get lastSeenAt(): Date { return this._lastSeenAt; }

  public updateActiveDoc(docId: string | null): void {
    this._activeDocId = docId;
    this._cursor = null;
    this._lastSeenAt = new Date();
  }

  public updateCursor(cursor: CursorPositionVo | null): void {
    this._cursor = cursor;
    this._lastSeenAt = new Date();
  }

  public heartbeat(): void {
    this._lastSeenAt = new Date();
  }

  public toPresenceVo(): UserPresenceVo {
    return new UserPresenceVo({
      userId: this._userId,
      socketId: this._socketId,
      name: this._name,
      color: this._color,
      avatar: this._avatar,
      activeDocId: this._activeDocId,
      cursor: this._cursor,
      lastSeenAt: this._lastSeenAt,
    });
  }

  private static generateColor(seed: string): string {
    const palette = [
      '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4',
      '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#14b8a6',
    ];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % palette.length;
    return palette[index];
  }
}
