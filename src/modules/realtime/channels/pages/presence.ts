import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';
import {
  PAGES_PRESENCE_COLORS,
  PAGES_REALTIME_DEFAULTS,
  PAGES_REDIS_KEYS,
  PagesRealtimeConfigService,
} from './config';
import type { CursorPosition, UserPresence } from './types';

export interface PublicPresence {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  socketId: string;
}

export class PresenceMapper {
  private static readonly DEFAULT_COLOR = '#3b82f6';
  private static readonly COLOR_HEX_REGEX =
    /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  public static sanitizeColor(color?: string | null): string {
    if (!color || typeof color !== 'string') {
      return PresenceMapper.DEFAULT_COLOR;
    }
    const trimmed = color.trim();
    return PresenceMapper.COLOR_HEX_REGEX.test(trimmed)
      ? trimmed
      : PresenceMapper.DEFAULT_COLOR;
  }

  public static sanitizeAvatar(avatar?: string | null): string | undefined {
    if (!avatar || typeof avatar !== 'string') {
      return undefined;
    }
    const trimmed = avatar.trim();
    if (trimmed.length === 0 || trimmed.length > 1000) {
      return undefined;
    }
    if (
      trimmed.startsWith('https://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('data:image/')
    ) {
      return trimmed;
    }
    return undefined;
  }

  public static toPublicPresence(
    data: {
      userId?: string;
      name?: string;
      color?: string | null;
      avatar?: string | null;
    },
    socketId: string,
  ): PublicPresence {
    return {
      userId: data.userId || '',
      name: data.name?.trim() || 'Collaborator',
      color: PresenceMapper.sanitizeColor(data.color),
      avatar: PresenceMapper.sanitizeAvatar(data.avatar),
      socketId,
    };
  }

  public static toLeavePresence(
    userId: string,
    socketId: string,
  ): { userId: string; socketId: string } {
    return {
      userId,
      socketId,
    };
  }
}

@Injectable()
export class RoomPresenceStore {
  private readonly logger = new Logger(RoomPresenceStore.name);

  private readonly sessions = new Map<string, UserPresence>();
  private readonly projectRooms = new Map<string, Set<string>>();
  private readonly docRooms = new Map<string, Set<string>>();
  private readonly lastCursorRedisSync = new Map<string, number>();

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly config?: PagesRealtimeConfigService,
  ) {}

  private get sessionTtlSeconds(): number {
    return (
      this.config?.getPresenceConfig?.()?.sessionTtlSeconds ??
      PAGES_REALTIME_DEFAULTS.presence.sessionTtlSeconds
    );
  }

  private get cursorRedisThrottleMs(): number {
    return (
      this.config?.getPresenceConfig?.()?.cursorRedisThrottleMs ??
      PAGES_REALTIME_DEFAULTS.presence.cursorRedisThrottleMs
    );
  }

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
    const index = Math.abs(hash) % PAGES_PRESENCE_COLORS.length;
    return PAGES_PRESENCE_COLORS[index];
  }

  public getSession(socketId: string): UserPresence | null {
    return this.sessions.get(socketId) ?? null;
  }

  public async addProjectSession(session: UserPresence): Promise<void> {
    if (!session.color) {
      session.color = this.getDeterministicColor(session.userId);
    }
    this.sessions.set(session.socketId, session);

    let room = this.projectRooms.get(session.spaceId);
    if (!room) {
      room = new Set();
      this.projectRooms.set(session.spaceId, room);
    }
    room.add(session.socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        await Promise.all([
          client.set(
            PAGES_REDIS_KEYS.presence(session.socketId),
            JSON.stringify(session),
            'EX',
            this.sessionTtlSeconds,
          ),
          client.sadd(
            PAGES_REDIS_KEYS.projectRoom(session.spaceId),
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
        const sessionKey = PAGES_REDIS_KEYS.presence(socketId);
        const projectKey = PAGES_REDIS_KEYS.projectRoom(projectId);

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
            client.srem(
              PAGES_REDIS_KEYS.docRoom(projectId, activeDocId),
              socketId,
            ),
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
        const projectKey = PAGES_REDIS_KEYS.projectRoom(projectId);
        const socketIds = await client.smembers(projectKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId: string) =>
          PAGES_REDIS_KEYS.presence(sId),
        );
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
          client.sadd(PAGES_REDIS_KEYS.docRoom(projectId, docId), socketId),
          client.set(
            PAGES_REDIS_KEYS.presence(socketId),
            JSON.stringify(session),
            'EX',
            this.sessionTtlSeconds,
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
          client.srem(PAGES_REDIS_KEYS.docRoom(projectId, docId), socketId),
        ];
        if (session) {
          tasks.push(
            client.set(
              PAGES_REDIS_KEYS.presence(socketId),
              JSON.stringify(session),
              'EX',
              this.sessionTtlSeconds,
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
        const docKey = PAGES_REDIS_KEYS.docRoom(projectId, docId);
        const socketIds = await client.smembers(docKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId: string) =>
          PAGES_REDIS_KEYS.presence(sId),
        );
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
      if (now - lastSync >= this.cursorRedisThrottleMs) {
        this.lastCursorRedisSync.set(socketId, now);
        try {
          const client = this.redis!.getClient()!;
          await client.set(
            PAGES_REDIS_KEYS.presence(socketId),
            JSON.stringify(session),
            'EX',
            this.sessionTtlSeconds,
          );
        } catch (err) {
          this.logger.warn(`Redis updateSessionCursor error: ${String(err)}`);
        }
      }
    }

    return session;
  }
}
