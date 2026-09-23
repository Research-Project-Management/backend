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
          JSON.stringify(session.toPresenceVo().toJSON()),
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
    const session = await this.fallbackMemory.removeProjectSession(projectId, socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const sessionKey = `manuscript:presence:${socketId}`;
        const projectKey = `manuscript:project_rooms:${projectId}`;

        await client.del(sessionKey);
        await client.srem(projectKey, socketId);
      } catch (err) {
        this.logger.warn(`Redis removeProjectSession error: ${err}`);
      }
    }

    return session;
  }

  public async getProjectSessions(projectId: string): Promise<UserPresenceVo[]> {
    return await this.fallbackMemory.getProjectSessions(projectId);
  }

  public async joinDocRoom(
    projectId: string,
    docId: string,
    socketId: string,
  ): Promise<UserPresenceVo[]> {
    const presenceList = await this.fallbackMemory.joinDocRoom(projectId, docId, socketId);

    if (this.isRedisActive()) {
      try {
        const client = this.redis!.getClient()!;
        const docKey = `manuscript:doc_rooms:${projectId}:${docId}`;
        await client.sadd(docKey, socketId);
      } catch (err) {
        this.logger.warn(`Redis joinDocRoom error: ${err}`);
      }
    }

    return presenceList;
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
      } catch (err) {
        this.logger.warn(`Redis leaveDocRoom error: ${err}`);
      }
    }
  }

  public async getDocSessions(projectId: string, docId: string): Promise<UserPresenceVo[]> {
    return await this.fallbackMemory.getDocSessions(projectId, docId);
  }

  public async updateSessionCursor(
    projectId: string,
    docId: string,
    socketId: string,
    cursor: CursorPositionVo,
  ): Promise<UserPresenceVo | null> {
    return await this.fallbackMemory.updateSessionCursor(projectId, docId, socketId, cursor);
  }

  public async getSession(socketId: string): Promise<PresenceSession | null> {
    return await this.fallbackMemory.getSession(socketId);
  }
}
