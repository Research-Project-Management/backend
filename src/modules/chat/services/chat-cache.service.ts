import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '@/core/infrastructure/redis/redis.service';

export interface CachedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  content: string;
  attachments?: unknown;
  replyToId?: string | null;
  replyTo?: {
    id: string;
    content: string;
    sender?: { name: string | null };
  } | null;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
  sender?: {
    id: string;
    name: string | null;
    avatar?: string | null;
    email?: string;
  };
  reactions?: Array<{
    id: string;
    userId: string;
    emoji: string;
  }>;
}

@Injectable()
export class ChatCacheService {
  private readonly logger = new Logger(ChatCacheService.name);
  private static readonly MAX_CACHED_MESSAGES = 50;
  private static readonly CACHE_TTL_SECONDS = 86400 * 7; // 7 days

  // In-memory fallback if Redis is unreachable
  private memoryCache = new Map<string, CachedMessage[]>();

  constructor(private readonly redisCache: RedisCacheService) {}

  private getKey(conversationId: string): string {
    return `chat:conv:${conversationId}:messages`;
  }

  /**
   * Retrieves up to 50 most recent messages directly from Redis RAM (0-1ms latency).
   * Returns null if cache miss, triggering cold storage DB read.
   */
  async getRecentMessages(
    conversationId: string,
    limit = 50,
  ): Promise<CachedMessage[] | null> {
    const key = this.getKey(conversationId);
    const client = this.redisCache.getClient();

    if (this.redisCache.isReady() && client) {
      try {
        const rawList = await client.lrange(
          key,
          0,
          Math.min(limit, ChatCacheService.MAX_CACHED_MESSAGES) - 1,
        );
        if (rawList && rawList.length > 0) {
          return rawList.map((item) => JSON.parse(item) as CachedMessage);
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Redis getRecentMessages error on ${key}: ${(err as Error)?.message}`,
        );
      }
    }

    // Check in-memory fallback
    const memList = this.memoryCache.get(conversationId);
    if (memList && memList.length > 0) {
      return memList.slice(0, limit);
    }

    return null;
  }

  /**
   * Pushes a newly sent message to the head of the Redis list and trims to 50 items.
   */
  async pushMessage(
    conversationId: string,
    message: CachedMessage,
  ): Promise<void> {
    const key = this.getKey(conversationId);
    const serialized = JSON.stringify(message);
    const client = this.redisCache.getClient();

    // 1. In-memory fallback
    const currentMem = this.memoryCache.get(conversationId) || [];
    currentMem.unshift(message);
    if (currentMem.length > ChatCacheService.MAX_CACHED_MESSAGES) {
      currentMem.pop();
    }
    this.memoryCache.set(conversationId, currentMem);

    // 2. Redis RAM
    if (this.redisCache.isReady() && client) {
      try {
        const pipeline = client.pipeline();
        pipeline.lpush(key, serialized);
        pipeline.ltrim(key, 0, ChatCacheService.MAX_CACHED_MESSAGES - 1);
        pipeline.expire(key, ChatCacheService.CACHE_TTL_SECONDS);
        await pipeline.exec();
      } catch (err: unknown) {
        this.logger.warn(
          `Redis pushMessage error on ${key}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  /**
   * Populates the Redis hot cache from PostgreSQL cold storage (e.g. after cache miss).
   * Expects messages sorted descending by createdAt (newest first).
   */
  async cacheRecentMessages(
    conversationId: string,
    messages: CachedMessage[],
  ): Promise<void> {
    if (!messages || messages.length === 0) return;
    const key = this.getKey(conversationId);
    const bounded = messages.slice(0, ChatCacheService.MAX_CACHED_MESSAGES);
    const client = this.redisCache.getClient();

    this.memoryCache.set(conversationId, [...bounded]);

    if (this.redisCache.isReady() && client) {
      try {
        const pipeline = client.pipeline();
        pipeline.del(key);
        // rpush in order of descending messages so index 0 is newest
        const serialized = bounded.map((m) => JSON.stringify(m));
        pipeline.rpush(key, ...serialized);
        pipeline.expire(key, ChatCacheService.CACHE_TTL_SECONDS);
        await pipeline.exec();
      } catch (err: unknown) {
        this.logger.warn(
          `Redis cacheRecentMessages error on ${key}: ${(err as Error)?.message}`,
        );
      }
    }
  }

  /**
   * Invalidates cache for a conversation (e.g. on mass purge or channel delete).
   */
  async invalidate(conversationId: string): Promise<void> {
    const key = this.getKey(conversationId);
    this.memoryCache.delete(conversationId);
    const client = this.redisCache.getClient();
    if (this.redisCache.isReady() && client) {
      try {
        await client.del(key);
      } catch (err: unknown) {
        this.logger.warn(
          `Redis invalidate error on ${key}: ${(err as Error)?.message}`,
        );
      }
    }
  }
}
