import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '@/core/infrastructure/redis/cache.service';

export interface ChatCacheConfig {
  maxCachedMessages: number;
  cacheTtlSeconds: number;
}

export const CHAT_CACHE_DEFAULTS: ChatCacheConfig = {
  maxCachedMessages: 50,
  cacheTtlSeconds: 86_400 * 7, // 7 days
};

export const CHAT_REDIS_KEYS = {
  conversationMessages: (conversationId: string): string =>
    `chat:conv:${conversationId}:messages`,
} as const;

function parsePositiveInt(
  raw: string | number | undefined,
  fallback: number,
): number {
  const parsed = typeof raw === 'number' ? raw : parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

  // In-memory fallback if Redis is unreachable
  private memoryCache = new Map<string, CachedMessage[]>();

  constructor(
    private readonly redisCache: RedisCacheService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  private get cacheConfig(): ChatCacheConfig {
    return {
      maxCachedMessages: parsePositiveInt(
        this.configService?.get<string | number>('CHAT_CACHE_MAX_MESSAGES'),
        CHAT_CACHE_DEFAULTS.maxCachedMessages,
      ),
      cacheTtlSeconds: parsePositiveInt(
        this.configService?.get<string | number>('CHAT_CACHE_TTL_SECONDS'),
        CHAT_CACHE_DEFAULTS.cacheTtlSeconds,
      ),
    };
  }

  private getKey(conversationId: string): string {
    return CHAT_REDIS_KEYS.conversationMessages(conversationId);
  }

  /**
   * Retrieves up to 50 most recent messages directly from Redis RAM (0-1ms latency).
   * Returns null if cache miss, triggering cold storage DB read.
   */
  async getRecentMessages(
    conversationId: string,
    limit = this.cacheConfig.maxCachedMessages,
  ): Promise<CachedMessage[] | null> {
    const key = this.getKey(conversationId);
    const client = this.redisCache.getClient();
    const { maxCachedMessages } = this.cacheConfig;

    if (this.redisCache.isReady() && client) {
      try {
        const rawList = await client.lrange(
          key,
          0,
          Math.min(limit, maxCachedMessages) - 1,
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
    const { maxCachedMessages, cacheTtlSeconds } = this.cacheConfig;

    // 1. In-memory fallback
    const currentMem = this.memoryCache.get(conversationId) || [];
    currentMem.unshift(message);
    if (currentMem.length > maxCachedMessages) {
      currentMem.pop();
    }
    this.memoryCache.set(conversationId, currentMem);

    // 2. Redis RAM
    if (this.redisCache.isReady() && client) {
      try {
        const pipeline = client.pipeline();
        pipeline.lpush(key, serialized);
        pipeline.ltrim(key, 0, maxCachedMessages - 1);
        pipeline.expire(key, cacheTtlSeconds);
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
    const { maxCachedMessages, cacheTtlSeconds } = this.cacheConfig;
    const bounded = messages.slice(0, maxCachedMessages);
    const client = this.redisCache.getClient();

    this.memoryCache.set(conversationId, [...bounded]);

    if (this.redisCache.isReady() && client) {
      try {
        const pipeline = client.pipeline();
        pipeline.del(key);
        // rpush in order of descending messages so index 0 is newest
        const serialized = bounded.map((m) => JSON.stringify(m));
        pipeline.rpush(key, ...serialized);
        pipeline.expire(key, cacheTtlSeconds);
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
    await this.redisCache.del(key);
  }
}
