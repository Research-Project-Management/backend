import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RedisCacheService } from '@/core';
import { LIBRARY_REDIS_KEYS } from '@/modules/library/core/config/library.config';
import { StateRepository } from '@/modules/library/catalog/repositories/saved-searches.repository';

export interface BufferedReadingProgress {
  currentPage?: number;
  scrollPosition?: unknown;
  attachmentId?: string;
  lastReadAt?: string;
  lastOpenedAt?: string;
}

@Injectable()
export class ReaderWriteBehindService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReaderWriteBehindService.name);
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private readonly FLUSH_INTERVAL_MS = 5000; // Flush coalesced records every 5s
  private readonly BATCH_USER_LIMIT = 50;

  constructor(
    @Optional() private readonly cache?: RedisCacheService,
    @Optional() private readonly stateRepository?: StateRepository,
  ) {}

  onModuleInit() {
    // Start periodic background flusher
    this.flushTimer = setInterval(() => {
      void this.flushBatch(this.BATCH_USER_LIMIT);
    }, this.FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  async onModuleDestroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain remaining dirty buffers synchronously before shutdown
    try {
      await this.flushBatch(500);
    } catch (err) {
      this.logger.warn(`Shutdown drain error: ${(err as Error).message}`);
    }
  }

  /**
   * Fast O(1) in-memory buffer write for high-frequency reader heartbeats.
   * Coalesces rapid scroll events, saving ~95% of database write IOPS.
   */
  async bufferProgress(
    userId: string,
    itemId: string,
    data: {
      currentPage?: number;
      scrollPosition?: unknown;
      attachmentId?: string;
      lastReadAt?: Date;
      lastOpenedAt?: Date;
    },
  ): Promise<boolean> {
    const client = this.cache?.getClient();
    if (!this.cache?.isReady() || !client) {
      // Fallback: If Redis is offline, write directly to database
      if (this.stateRepository) {
        await this.stateRepository.upsertState(userId, itemId, {
          currentPage: data.currentPage,
          scrollPosition: data.scrollPosition as
            | Record<string, unknown>
            | unknown[]
            | null
            | undefined,
          attachmentId: data.attachmentId,
          lastReadAt: data.lastReadAt,
          lastOpenedAt: data.lastOpenedAt,
        });
      }
      return false;
    }

    try {
      const hashKey = LIBRARY_REDIS_KEYS.readerProgress(userId);
      const dirtySetKey = LIBRARY_REDIS_KEYS.readerDirtyUsers();

      const payload: BufferedReadingProgress = {
        currentPage: data.currentPage,
        scrollPosition: data.scrollPosition,
        attachmentId: data.attachmentId,
        lastReadAt: data.lastReadAt ? data.lastReadAt.toISOString() : new Date().toISOString(),
        lastOpenedAt: data.lastOpenedAt ? data.lastOpenedAt.toISOString() : undefined,
      };

      const pipeline = client.pipeline();
      pipeline.hset(hashKey, itemId, JSON.stringify(payload));
      pipeline.expire(hashKey, 86400); // 24-hour retention safety net
      pipeline.sadd(dirtySetKey, userId);
      await pipeline.exec();
      return true;
    } catch (err) {
      this.logger.debug(
        `Failed to buffer progress for user ${userId}, falling back to DB: ${(err as Error).message}`,
      );
      if (this.stateRepository) {
        await this.stateRepository.upsertState(userId, itemId, {
          currentPage: data.currentPage,
          scrollPosition: data.scrollPosition as
            | Record<string, unknown>
            | unknown[]
            | null
            | undefined,
          attachmentId: data.attachmentId,
          lastReadAt: data.lastReadAt,
          lastOpenedAt: data.lastOpenedAt,
        });
      }
      return false;
    }
  }

  /**
   * Retrieves any buffered, unflushed reading progress for a user and item.
   */
  async getBufferedProgress(
    userId: string,
    itemId: string,
  ): Promise<BufferedReadingProgress | null> {
    const client = this.cache?.getClient();
    if (!this.cache?.isReady() || !client) return null;

    try {
      const hashKey = LIBRARY_REDIS_KEYS.readerProgress(userId);
      const raw = await client.hget(hashKey, itemId);
      if (!raw) return null;
      return JSON.parse(raw) as BufferedReadingProgress;
    } catch {
      return null;
    }
  }

  /**
   * Background Flusher: Pops dirty users from the set and flushes their coalesced
   * latest state into PostgreSQL in a clean single pass per item.
   */
  async flushBatch(batchLimit = this.BATCH_USER_LIMIT): Promise<number> {
    if (this.isFlushing || !this.stateRepository) return 0;
    const client = this.cache?.getClient();
    if (!this.cache?.isReady() || !client) return 0;

    this.isFlushing = true;
    let flushedCount = 0;

    try {
      const dirtySetKey = LIBRARY_REDIS_KEYS.readerDirtyUsers();
      // Pop a batch of dirty users atomically
      const dirtyUsers = await client.spop(dirtySetKey, batchLimit);
      if (!dirtyUsers || dirtyUsers.length === 0) return 0;

      for (const uId of dirtyUsers) {
        const hashKey = LIBRARY_REDIS_KEYS.readerProgress(uId);
        const allItems = await client.hgetall(hashKey);
        if (!allItems || Object.keys(allItems).length === 0) continue;

        const flushedItemIds: string[] = [];

        for (const [itId, progressJson] of Object.entries(allItems)) {
          try {
            const data = JSON.parse(progressJson) as BufferedReadingProgress;
            await this.stateRepository.upsertState(uId, itId, {
              currentPage: data.currentPage,
              scrollPosition: data.scrollPosition as
                | Record<string, unknown>
                | unknown[]
                | null
                | undefined,
              attachmentId: data.attachmentId,
              lastReadAt: data.lastReadAt ? new Date(data.lastReadAt) : undefined,
              lastOpenedAt: data.lastOpenedAt ? new Date(data.lastOpenedAt) : undefined,
            });
            flushedItemIds.push(itId);
            flushedCount++;
          } catch (writeErr) {
            this.logger.warn(
              `Failed flushing progress for user ${uId}, item ${itId}: ${(writeErr as Error).message}`,
            );
          }
        }

        if (flushedItemIds.length > 0) {
          await client.hdel(hashKey, ...flushedItemIds);
        }
      }
    } catch (flushErr) {
      this.logger.warn(`Error during write-behind flush cycle: ${(flushErr as Error).message}`);
    } finally {
      this.isFlushing = false;
    }

    return flushedCount;
  }
}
