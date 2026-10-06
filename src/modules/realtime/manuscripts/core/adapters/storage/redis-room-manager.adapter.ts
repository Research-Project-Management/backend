/**
 * realtime/core/adapters/storage/redis-room-manager.adapter.ts
 * Driven Adapter implementing IRoomManagerPort with Redis (and fallback in-memory cache).
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { IRoomManagerPort } from '../../ports/room-manager.port';
import { PresenceSession } from '../../domain/entities/presence-session.entity';
import { UserPresenceVo } from '../../domain/value-objects/user-presence.vo';
import { CursorPositionVo } from '../../domain/value-objects/cursor-position.vo';
import { InMemoryRoomManagerAdapter } from './in-memory-room-manager.adapter';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class RedisRoomManagerAdapter extends IRoomManagerPort {
  private readonly logger = new Logger(RedisRoomManagerAdapter.name);
  private readonly fallbackMemory = new InMemoryRoomManagerAdapter();

  constructor(@Optional() private readonly redis?: RedisCacheService) {
    super();
  }

  private isRedisActive(): boolean {
    return !!(this.redis && this.redis.isReady() && this.redis.getClient());
  }

  public async addProjectSession(session: PresenceSession): Promise<void> {
    await this.fallbackMemory.addProjectSession(session);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const sessionKey = `manuscript:presence:${session.socketId}`;
        const projectKey = `manuscript:project_rooms:${session.projectId}`;

        await client.set(
          sessionKey,
          JSON.stringify(session.toJSON()),
          'EX',
          86400,
        );
        await client.sadd(projectKey, session.socketId);
      } catch (err) {
        this.logger.warn(`Redis addProjectSession error: ${err}`);
      }
    }
  }

  public async removeProjectSession(
    projectId: string,
    socketId: string,
  ): Promise<PresenceSession | null> {
    const session = await this.fallbackMemory.removeProjectSession(
      projectId,
      socketId,
    );

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const sessionKey = `manuscript:presence:${socketId}`;
        const projectKey = `manuscript:project_rooms:${projectId}`;

        // Clean up from doc room if active
        let activeDocId = session?.activeDocId;
        if (!activeDocId) {
          const raw = await client.get(sessionKey);
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              activeDocId = parsed.activeDocId;
            } catch {}
          }
        }

        if (activeDocId) {
          const docKey = `manuscript:doc_rooms:${projectId}:${activeDocId}`;
          await client.srem(docKey, socketId);
        }

        await client.del(sessionKey);
        await client.srem(projectKey, socketId);
      } catch (err) {
        this.logger.warn(`Redis removeProjectSession error: ${err}`);
      }
    }

    return session;
  }

  public async getProjectSessions(
    projectId: string,
  ): Promise<UserPresenceVo[]> {
    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const projectKey = `manuscript:project_rooms:${projectId}`;
        const socketIds = await client.smembers(projectKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId) => `manuscript:presence:${sId}`);
        const rawSessions = await client.mget(...keys);

        const presences: UserPresenceVo[] = [];
        const deadSocketIds: string[] = [];

        for (let i = 0; i < socketIds.length; i++) {
          const raw = rawSessions[i];
          const sId = socketIds[i];
          if (raw) {
            try {
              presences.push(UserPresenceVo.fromJSON(JSON.parse(raw)));
            } catch {
              deadSocketIds.push(sId);
            }
          } else {
            deadSocketIds.push(sId);
          }
        }

        if (deadSocketIds.length > 0) {
          await client.srem(projectKey, ...deadSocketIds).catch(() => {});
        }

        return presences;
      } catch (err) {
        this.logger.warn(`Redis getProjectSessions error: ${err}`);
      }
    }

    return await this.fallbackMemory.getProjectSessions(projectId);
  }

  public async joinDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<UserPresenceVo[]> {
    await this.fallbackMemory.joinDocRoom(projectId, docId, socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const docKey = `manuscript:doc_rooms:${projectId}:${docId}`;
        await client.sadd(docKey, socketId);

        const sessionKey = `manuscript:presence:${socketId}`;
        const raw = await client.get(sessionKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.activeDocId && parsed.activeDocId !== docId) {
            const oldDocKey = `manuscript:doc_rooms:${projectId}:${parsed.activeDocId}`;
            await client.srem(oldDocKey, socketId).catch(() => {});
          }
          parsed.activeDocId = docId;
          parsed.cursor = null;
          parsed.lastSeenAt = new Date().toISOString();
          await client.set(sessionKey, JSON.stringify(parsed), 'EX', 86400);
        }

        return await this.getDocSessions(projectId, docId);
      } catch (err) {
        this.logger.warn(`Redis joinDocRoom error: ${err}`);
      }
    }

    return await this.fallbackMemory.getDocSessions(projectId, docId);
  }

  public async leaveDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<void> {
    await this.fallbackMemory.leaveDocRoom(projectId, docId, socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const docKey = `manuscript:doc_rooms:${projectId}:${docId}`;
        await client.srem(docKey, socketId);

        const sessionKey = `manuscript:presence:${socketId}`;
        const raw = await client.get(sessionKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.activeDocId === docId) {
            parsed.activeDocId = null;
            parsed.cursor = null;
            parsed.lastSeenAt = new Date().toISOString();
            await client.set(sessionKey, JSON.stringify(parsed), 'EX', 86400);
          }
        }
      } catch (err) {
        this.logger.warn(`Redis leaveDocRoom error: ${err}`);
      }
    }
  }

  public async getDocSessions(
    projectId: string,
    docId: string,
  ): Promise<UserPresenceVo[]> {
    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const docKey = `manuscript:doc_rooms:${projectId}:${docId}`;
        const socketIds = await client.smembers(docKey);

        if (!socketIds || socketIds.length === 0) {
          return [];
        }

        const keys = socketIds.map((sId) => `manuscript:presence:${sId}`);
        const rawSessions = await client.mget(...keys);

        const presences: UserPresenceVo[] = [];
        const deadSocketIds: string[] = [];

        for (let i = 0; i < socketIds.length; i++) {
          const raw = rawSessions[i];
          const sId = socketIds[i];
          if (raw) {
            try {
              presences.push(UserPresenceVo.fromJSON(JSON.parse(raw)));
            } catch {
              deadSocketIds.push(sId);
            }
          } else {
            deadSocketIds.push(sId);
          }
        }

        if (deadSocketIds.length > 0) {
          await client.srem(docKey, ...deadSocketIds).catch(() => {});
        }

        return presences;
      } catch (err) {
        this.logger.warn(`Redis getDocSessions error: ${err}`);
      }
    }

    return await this.fallbackMemory.getDocSessions(projectId, docId);
  }

  public async updateSessionCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPositionVo,
  ): Promise<UserPresenceVo | null> {
    const localPresence = await this.fallbackMemory.updateSessionCursor(
      projectId,
      docId,
      socketId,
      cursor,
    );

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const sessionKey = `manuscript:presence:${socketId}`;
        const raw = await client.get(sessionKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          parsed.activeDocId = docId;
          parsed.cursor = cursor.toJSON();
          parsed.lastSeenAt = new Date().toISOString();
          await client.set(sessionKey, JSON.stringify(parsed), 'EX', 86400);
          return UserPresenceVo.fromJSON(parsed);
        }
      } catch (err) {
        this.logger.warn(`Redis updateSessionCursor error: ${err}`);
      }
    }

    return localPresence;
  }

  public async getSession(socketId: string): Promise<PresenceSession | null> {
    const localSession = await this.fallbackMemory.getSession(socketId);
    if (localSession) {
      return localSession;
    }

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const raw = await client.get(`manuscript:presence:${socketId}`);
        if (raw) {
          return PresenceSession.fromJSON(JSON.parse(raw));
        }
      } catch (err) {
        this.logger.warn(`Redis getSession error: ${err}`);
      }
    }

    return null;
  }
}
