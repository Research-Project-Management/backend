/**
 * realtime/core/domain/entities/doc-room.entity.ts
 * Domain Entity representing an active document collaboration room.
 */

import { PresenceSession } from './presence-session.entity';
import { UserPresenceVo } from '../value-objects/user-presence.vo';

export class DocRoom {
  public readonly projectId: string;
  public readonly docId: string;
  private readonly _sessions = new Map<string, PresenceSession>(); // key: socketId

  constructor(projectId: string, docId: string) {
    this.projectId = projectId;
    this.docId = docId;
  }

  public get socketCount(): number {
    return this._sessions.size;
  }

  public addSession(session: PresenceSession): void {
    this._sessions.set(session.socketId, session);
  }

  public removeSession(socketId: string): PresenceSession | null {
    const session = this._sessions.get(socketId);
    if (session) {
      this._sessions.delete(socketId);
      return session;
    }
    return null;
  }

  public getSession(socketId: string): PresenceSession | null {
    return this._sessions.get(socketId) ?? null;
  }

  public getAllPresence(): UserPresenceVo[] {
    return Array.from(this._sessions.values()).map((s) => s.toPresenceVo());
  }

  public getAllSocketIds(): string[] {
    return Array.from(this._sessions.keys());
  }

  public isEmpty(): boolean {
    return this._sessions.size === 0;
  }
}
