/**
 * realtime/core/adapters/storage/in-memory-room-manager.adapter.ts
 * Driven Adapter implementing IRoomManagerPort in-memory for unit tests & single-process dev.
 */

import { Injectable } from '@nestjs/common';
import { IRoomManagerPort } from '../../ports/room-manager.port';
import { PresenceSession } from '../../domain/entities/presence-session.entity';
import { DocRoom } from '../../domain/entities/doc-room.entity';
import { UserPresenceVo } from '../../domain/value-objects/user-presence.vo';
import { CursorPositionVo } from '../../domain/value-objects/cursor-position.vo';

@Injectable()
export class InMemoryRoomManagerAdapter extends IRoomManagerPort {
  // key: socketId -> PresenceSession
  private readonly socketSessions = new Map<string, PresenceSession>();

  // key: projectId -> Set of socketIds
  private readonly projectRooms = new Map<string, Set<string>>();

  // key: `${projectId}:${docId}` -> DocRoom
  private readonly docRooms = new Map<string, DocRoom>();

  private docRoomKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  public async addProjectSession(session: PresenceSession): Promise<void> {
    this.socketSessions.set(session.socketId, session);

    let room = this.projectRooms.get(session.projectId);
    if (!room) {
      room = new Set<string>();
      this.projectRooms.set(session.projectId, room);
    }
    room.add(session.socketId);
  }

  public async removeProjectSession(
    projectId: string,
    socketId: string,
  ): Promise<PresenceSession | null> {
    const session = this.socketSessions.get(socketId);
    if (!session) return null;

    this.socketSessions.delete(socketId);

    const projectRoom = this.projectRooms.get(projectId);
    if (projectRoom) {
      projectRoom.delete(socketId);
      if (projectRoom.size === 0) {
        this.projectRooms.delete(projectId);
      }
    }

    if (session.activeDocId) {
      await this.leaveDocRoom(projectId, session.activeDocId, socketId);
    }

    return session;
  }

  public async getProjectSessions(projectId: string): Promise<UserPresenceVo[]> {
    const socketIds = this.projectRooms.get(projectId);
    if (!socketIds) return [];

    const result: UserPresenceVo[] = [];
    for (const sId of socketIds) {
      const session = this.socketSessions.get(sId);
      if (session) {
        result.push(session.toPresenceVo());
      }
    }
    return result;
  }

  public async joinDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<UserPresenceVo[]> {
    const session = this.socketSessions.get(socketId);
    if (!session) {
      return [];
    }

    // Leave any previous doc room if different
    if (session.activeDocId && session.activeDocId !== docId) {
      await this.leaveDocRoom(projectId, session.activeDocId, socketId);
    }

    session.updateActiveDoc(docId);

    const roomKey = this.docRoomKey(projectId, docId);
    let docRoom = this.docRooms.get(roomKey);
    if (!docRoom) {
      docRoom = new DocRoom(projectId, docId);
      this.docRooms.set(roomKey, docRoom);
    }

    docRoom.addSession(session);
    return docRoom.getAllPresence();
  }

  public async leaveDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<void> {
    const roomKey = this.docRoomKey(projectId, docId);
    const docRoom = this.docRooms.get(roomKey);
    if (docRoom) {
      docRoom.removeSession(socketId);
      if (docRoom.isEmpty()) {
        this.docRooms.delete(roomKey);
      }
    }

    const session = this.socketSessions.get(socketId);
    if (session && session.activeDocId === docId) {
      session.updateActiveDoc(null);
    }
  }

  public async getDocSessions(projectId: string, docId: string): Promise<UserPresenceVo[]> {
    const roomKey = this.docRoomKey(projectId, docId);
    const docRoom = this.docRooms.get(roomKey);
    return docRoom ? docRoom.getAllPresence() : [];
  }

  public async updateSessionCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPositionVo,
  ): Promise<UserPresenceVo | null> {
    const session = this.socketSessions.get(socketId);
    if (!session) return null;

    session.updateCursor(cursor);
    return session.toPresenceVo();
  }

  public async getSession(socketId: string): Promise<PresenceSession | null> {
    return this.socketSessions.get(socketId) ?? null;
  }

  public clear(): void {
    this.socketSessions.clear();
    this.projectRooms.clear();
    this.docRooms.clear();
  }
}
