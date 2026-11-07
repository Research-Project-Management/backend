import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import { UserPresence, CursorPosition } from './types/presence.type';
import { REDIS_KEYS } from '../core/realtime.constant';

@Injectable()
export class RoomStore {
  private readonly logger = new Logger(RoomStore.name);

  // In-memory hot storage:
  // socketId -> UserPresence
  private readonly sessions = new Map<string, UserPresence>();
  // projectId -> Set<socketId>
  private readonly projectRooms = new Map<string, Set<string>>();
  // `${projectId}:${docId}` -> Set<socketId>
  private readonly docRooms = new Map<string, Set<string>>();
  // socketId -> last Redis cursor sync timestamp (ms)
  private readonly lastCursorRedisSync = new Map<string, number>();
  private static readonly CURSOR_REDIS_THROTTLE_MS = 2000;

  private static readonly COLOR_PALETTE = [
    '#3B82F6',
    '#EF4444',
    '#10B981',
    '#F59E0B',
    '#8B5CF6',
    '#EC4899',
    '#06B6D4',
    '#84CC16',
    '#F97316',
    '#6366F1',
    '#14B8A6',
    '#D946EF',
  ];

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  private isRedisActive(): boolean {
    return !!(this.redis && this.redis.isReady() && this.redis.getClient());
  }

  private docKey(projectId: string, docId: string): string {
    return `${projectId}:${docId}`;
  }

  public getDeterministicColor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = (hash << 5) - hash + userId.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % RoomStore.COLOR_PALETTE.length;
    return RoomStore.COLOR_PALETTE[index];
  }

  public getSession(socketId: string): UserPresence | null {
    return this.sessions.get(socketId) ?? null;
  }

  public async addProjectSession(session: UserPresence): Promise<void> {
    if (!session.color) {
      session.color = this.getDeterministicColor(session.userId);
    }
    this.sessions.set(session.socketId, session);

    let room = this.projectRooms.get(session.projectId);
    if (!room) {
      room = new Set();
      this.projectRooms.set(session.projectId, room);
    }
    room.add(session.socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        await Promise.all([
          client.set(
            REDIS_KEYS.presence(session.socketId),
            JSON.stringify(session),
            'EX',
            86400,
          ),
          client.sadd(
            REDIS_KEYS.projectRoom(session.projectId),
            session.socketId,
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Redis addProjectSession error: ${String(err)}`);
      }
    }
  }

  public async removeProjectSession(
    projectId: string,
    socketId: string,
  ): Promise<UserPresence | null> {
    const session = this.sessions.get(socketId);
    let activeDocId = session?.activeDocId;

    this.sessions.delete(socketId);
    this.lastCursorRedisSync.delete(socketId);

    const projectRoom = this.projectRooms.get(projectId);
    if (projectRoom) {
      projectRoom.delete(socketId);
      if (projectRoom.size === 0) {
        this.projectRooms.delete(projectId);
      }
    }

    if (activeDocId) {
      await this.leaveDocRoom(projectId, activeDocId, socketId);
    }

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const sessionKey = REDIS_KEYS.presence(socketId);
        const projectKey = REDIS_KEYS.projectRoom(projectId);

        if (!activeDocId) {
          const raw = await client.get(sessionKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as UserPresence;
              activeDocId = parsed.activeDocId;
            } catch {
              // Ignore parse error
            }
          }
        }

        const tasks: Promise<unknown>[] = [
          client.del(sessionKey),
          client.srem(projectKey, socketId),
        ];
        if (activeDocId) {
          tasks.push(
            client.srem(REDIS_KEYS.docRoom(projectId, activeDocId), socketId),
          );
        }
        await Promise.all(tasks);
      } catch (err) {
        this.logger.warn(`Redis removeProjectSession error: ${String(err)}`);
      }
    }

    return session ?? null;
  }

  public async getProjectSessions(projectId: string): Promise<UserPresence[]> {
    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const projectKey = REDIS_KEYS.projectRoom(projectId);
        const socketIds = await client.smembers(projectKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId: string) => REDIS_KEYS.presence(sId));
        const rawSessions = await client.mget(...keys);

        const results: UserPresence[] = [];
        const staleSockets: string[] = [];

        for (let i = 0; i < socketIds.length; i++) {
          const raw = rawSessions[i];
          const socketId = socketIds[i];

          if (raw) {
            try {
              results.push(JSON.parse(raw) as UserPresence);
            } catch {
              staleSockets.push(socketId);
            }
          } else {
            staleSockets.push(socketId);
          }
        }

        if (staleSockets.length > 0) {
          await client.srem(projectKey, ...staleSockets).catch((err) => {
            this.logger.warn(
              `Redis srem stale project sockets error: ${String(err)}`,
            );
          });
        }

        return results;
      } catch (err) {
        this.logger.warn(`Redis getProjectSessions error: ${String(err)}`);
      }
    }

    const socketIds = this.projectRooms.get(projectId);
    if (!socketIds) return [];

    const result: UserPresence[] = [];
    for (const sId of socketIds) {
      const s = this.sessions.get(sId);
      if (s) result.push(s);
    }
    return result;
  }

  public async joinDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<UserPresence[]> {
    const session = this.sessions.get(socketId);
    if (!session) return [];

    if (session.activeDocId && session.activeDocId !== docId) {
      await this.leaveDocRoom(projectId, session.activeDocId, socketId);
    }

    session.activeDocId = docId;

    const key = this.docKey(projectId, docId);
    let docRoom = this.docRooms.get(key);
    if (!docRoom) {
      docRoom = new Set();
      this.docRooms.set(key, docRoom);
    }
    docRoom.add(socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        await Promise.all([
          client.sadd(REDIS_KEYS.docRoom(projectId, docId), socketId),
          client.set(
            REDIS_KEYS.presence(socketId),
            JSON.stringify(session),
            'EX',
            86400,
          ),
        ]);
      } catch (err) {
        this.logger.warn(`Redis joinDocRoom error: ${String(err)}`);
      }
    }

    return this.getDocSessions(projectId, docId);
  }

  public async leaveDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<void> {
    this.lastCursorRedisSync.delete(socketId);
    const session = this.sessions.get(socketId);
    if (session && session.activeDocId === docId) {
      session.activeDocId = null;
      session.cursor = null;
    }

    const key = this.docKey(projectId, docId);
    const docRoom = this.docRooms.get(key);
    if (docRoom) {
      docRoom.delete(socketId);
      if (docRoom.size === 0) {
        this.docRooms.delete(key);
      }
    }

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const tasks: Promise<unknown>[] = [
          client.srem(REDIS_KEYS.docRoom(projectId, docId), socketId),
        ];
        if (session) {
          tasks.push(
            client.set(
              REDIS_KEYS.presence(socketId),
              JSON.stringify(session),
              'EX',
              86400,
            ),
          );
        }
        await Promise.all(tasks);
      } catch (err) {
        this.logger.warn(`Redis leaveDocRoom error: ${String(err)}`);
      }
    }
  }

  public async getDocSessions(
    projectId: string,
    docId: string,
  ): Promise<UserPresence[]> {
    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const docKey = REDIS_KEYS.docRoom(projectId, docId);
        const socketIds = await client.smembers(docKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId: string) => REDIS_KEYS.presence(sId));
        const rawSessions = await client.mget(...keys);

        const results: UserPresence[] = [];
        const staleSockets: string[] = [];

        for (let i = 0; i < socketIds.length; i++) {
          const raw = rawSessions[i];
          const socketId = socketIds[i];

          if (raw) {
            try {
              results.push(JSON.parse(raw) as UserPresence);
            } catch {
              staleSockets.push(socketId);
            }
          } else {
            staleSockets.push(socketId);
          }
        }

        if (staleSockets.length > 0) {
          await client.srem(docKey, ...staleSockets).catch((err) => {
            this.logger.warn(
              `Redis srem stale doc sockets error: ${String(err)}`,
            );
          });
        }

        return results;
      } catch (err) {
        this.logger.warn(`Redis getDocSessions error: ${String(err)}`);
      }
    }

    const key = this.docKey(projectId, docId);
    const socketIds = this.docRooms.get(key);
    if (!socketIds) return [];

    const result: UserPresence[] = [];
    for (const sId of socketIds) {
      const s = this.sessions.get(sId);
      if (s) result.push(s);
    }
    return result;
  }

  public async updateSessionCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPosition,
  ): Promise<UserPresence | null> {
    const session = this.sessions.get(socketId);
    if (!session) return null;

    session.cursor = {
      row: Math.max(0, Math.floor(cursor.row)),
      column: Math.max(0, Math.floor(cursor.column)),
      selection: cursor.selection
        ? {
            anchor: {
              row: Math.max(0, Math.floor(cursor.selection.anchor.row)),
              column: Math.max(0, Math.floor(cursor.selection.anchor.column)),
            },
            head: {
              row: Math.max(0, Math.floor(cursor.selection.head.row)),
              column: Math.max(0, Math.floor(cursor.selection.head.column)),
            },
          }
        : undefined,
    };
    const now = Date.now();
    session.lastHeartbeat = now;

    if (this.isRedisActive()) {
      const lastSync = this.lastCursorRedisSync.get(socketId) ?? 0;
      if (now - lastSync >= RoomStore.CURSOR_REDIS_THROTTLE_MS) {
        this.lastCursorRedisSync.set(socketId, now);
        try {
          const client = this.redis!.getClient()!;
          await client.set(
            REDIS_KEYS.presence(socketId),
            JSON.stringify(session),
            'EX',
            86400,
          );
        } catch (err) {
          this.logger.warn(`Redis updateSessionCursor error: ${String(err)}`);
        }
      }
    }

    return session;
  }
}
