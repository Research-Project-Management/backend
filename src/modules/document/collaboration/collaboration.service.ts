import { Injectable, Optional, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CursorPositionDto } from './dto/collaboration.dto';
import { PrismaService } from '@/core/database/prisma.service';
import { DOCUMENT_REDIS_KEYS } from '../page/constants/page-redis-keys.constant';

export interface PresenceUser {
  id: string;
  name: string;
  avatar?: string;
  role: string;
  color: string;
  cursor?: CursorPositionDto;
  lastHeartbeat: number;
}

const USER_COLORS = [
  '#3B82F6', // Blue
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#84CC16', // Lime
];

function assignUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % USER_COLORS.length;
  return USER_COLORS[index];
}

@Injectable()
export class CollaborationService {
  private readonly logger = new Logger(CollaborationService.name);
  private readonly presenceRooms = new Map<string, Map<string, PresenceUser>>();
  private static readonly PRESENCE_TIMEOUT_MS = 35_000; // 35 seconds

  constructor(
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  /**
   * Registers/updates a user's presence & cursor location in a document room.
   * Persists to distributed Redis Hash (flux:collab:presence:{pageId}) with sliding TTL.
   */
  async updatePresence(
    pageId: string,
    user: { id: string; name: string; avatar?: string; role: string },
    cursor?: CursorPositionDto,
  ): Promise<PresenceUser[]> {
    let room = this.presenceRooms.get(pageId);
    if (!room) {
      room = new Map<string, PresenceUser>();
      this.presenceRooms.set(pageId, room);
    }

    const now = Date.now();
    const isNew = !room.has(user.id);
    const existing = room.get(user.id);

    const presenceUser: PresenceUser = {
      id: user.id,
      name: user.name || 'Anonymous Researcher',
      avatar: user.avatar,
      role: user.role,
      color: existing?.color || assignUserColor(user.id),
      cursor: cursor || existing?.cursor,
      lastHeartbeat: now,
    };

    // Update in-memory fallback
    room.set(user.id, presenceUser);
    this.cleanStaleUsers(pageId, now);

    // Distributed Redis Hash update
    const redisClient = this.redis?.getClient();
    if (this.redis?.isReady() && redisClient) {
      try {
        const key = DOCUMENT_REDIS_KEYS.presence(pageId);
        await redisClient.hset(key, user.id, JSON.stringify(presenceUser));
        await redisClient.expire(key, 60); // 60s sliding window
      } catch (err: any) {
        this.logger.warn(
          `Redis updatePresence failed for page ${pageId}: ${err?.message || err}`,
        );
      }
    }

    // Emit event for real-time SSE stream
    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: isNew ? 'user-joined' : 'cursor-updated',
      user: presenceUser,
      timestamp: now,
    });

    return this.getActiveUsers(pageId);
  }

  /**
   * Explicitly leaves a document room. Removes from Redis Hash.
   */
  async leaveRoom(pageId: string, userId: string): Promise<PresenceUser[]> {
    const room = this.presenceRooms.get(pageId);
    if (room && room.has(userId)) {
      room.delete(userId);
      if (room.size === 0) {
        this.presenceRooms.delete(pageId);
      }
    }

    const redisClient = this.redis?.getClient();
    if (this.redis?.isReady() && redisClient) {
      try {
        const key = DOCUMENT_REDIS_KEYS.presence(pageId);
        await redisClient.hdel(key, userId);
      } catch (err: any) {
        this.logger.warn(
          `Redis leaveRoom failed for page ${pageId}: ${err?.message || err}`,
        );
      }
    }

    this.eventEmitter?.emit('document.collaboration.event', {
      pageId,
      type: 'user-left',
      userId,
      timestamp: Date.now(),
    });

    return this.getActiveUsers(pageId);
  }

  /**
   * Retrieves list of active users in a document room.
   * Reads from Redis Hash with in-memory fallback, pruning stale entries.
   */
  async getActiveUsers(pageId: string): Promise<PresenceUser[]> {
    const now = Date.now();
    const redisClient = this.redis?.getClient();

    if (this.redis?.isReady() && redisClient) {
      try {
        const key = DOCUMENT_REDIS_KEYS.presence(pageId);
        const data = await redisClient.hgetall(key);
        if (data && Object.keys(data).length > 0) {
          const activeUsers: PresenceUser[] = [];
          const staleUserIds: string[] = [];

          for (const [userId, rawJson] of Object.entries(data)) {
            try {
              const u: PresenceUser = JSON.parse(rawJson);
              if (
                now - u.lastHeartbeat <=
                CollaborationService.PRESENCE_TIMEOUT_MS
              ) {
                activeUsers.push(u);
              } else {
                staleUserIds.push(userId);
              }
            } catch {
              staleUserIds.push(userId);
            }
          }

          if (staleUserIds.length > 0) {
            await redisClient.hdel(key, ...staleUserIds).catch(() => {});
          }

          return activeUsers;
        }
      } catch (err: any) {
        this.logger.warn(
          `Redis getActiveUsers failed for page ${pageId}: ${err?.message || err}`,
        );
      }
    }

    // In-memory fallback
    const room = this.presenceRooms.get(pageId);
    if (!room) return [];
    this.cleanStaleUsers(pageId, now);
    return Array.from(room.values());
  }

  /**
   * Broadcasts document lock state change to all active collaborators,
   * persists isLocked to Postgres, and invalidates Redis cache.
   */
  async broadcastLockChange(
    pageId: string,
    isLocked: boolean,
    lockedBy: string,
  ) {
    if (this.prisma?.page) {
      try {
        const updated = await this.prisma.page.update({
          where: { id: pageId },
          data: { isLocked },
          select: { id: true, projectId: true },
        });
        if (this.redis) {
          await Promise.all([
            this.redis.del(DOCUMENT_REDIS_KEYS.page(pageId)),
            this.redis.del(DOCUMENT_REDIS_KEYS.projectTree(updated.projectId)),
          ]);
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to persist isLocked state for page ${pageId}: ${err?.message || err}`,
        );
      }
    }

    const payload = {
      pageId,
      type: isLocked ? 'page-locked' : 'page-unlocked',
      isLocked,
      lockedBy,
      timestamp: Date.now(),
    };
    this.eventEmitter?.emit('document.collaboration.event', payload);
    // Also emit canonical 'lock-updated' for full cross-system compatibility
    this.eventEmitter?.emit('document.collaboration.event', {
      ...payload,
      type: 'lock-updated',
    });
  }

  private cleanStaleUsers(pageId: string, now: number) {
    const room = this.presenceRooms.get(pageId);
    if (!room) return;

    for (const [userId, user] of room.entries()) {
      if (now - user.lastHeartbeat > CollaborationService.PRESENCE_TIMEOUT_MS) {
        room.delete(userId);
        this.eventEmitter?.emit('document.collaboration.event', {
          pageId,
          type: 'user-left',
          userId,
          timestamp: now,
        });
      }
    }
  }
}
