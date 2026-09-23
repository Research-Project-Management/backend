import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core/cache/redis.service';

export interface IdempotentConsumerOptions<T> {
  consumer: string;
  eventId: string;
  leaseTtlSeconds?: number;
  retentionTtlSeconds?: number;
  handler: () => Promise<T>;
}

export interface IdempotentResult<T> {
  executed: boolean;
  skipped: boolean;
  reason?: 'ALREADY_COMPLETED' | 'IN_FLIGHT';
  result?: T;
}

interface MemoryInboxEntry {
  status: 'processing' | 'completed';
  expiresAt: number;
}

/**
 * Idempotent Consumer & Deduplication Log Service (Inbox Pattern).
 *
 * Guarantees exactly-once processing semantics for distributed event subscribers
 * and asynchronous background consumers (such as GROBID extraction, OCR, indexing).
 *
 * Employs atomic Redis lease locking (`SET ... NX EX`) with automatic in-memory LRU fallback.
 */
@Injectable()
export class IdempotentConsumerService {
  private readonly logger = new Logger(IdempotentConsumerService.name);

  // In-memory fallback cache
  private readonly memoryStore = new Map<string, MemoryInboxEntry>();
  private static readonly MAX_MEMORY_STORE_SIZE = 5000;

  constructor(@Optional() private readonly redis?: RedisCacheService) {}

  /**
   * Generates standardized inbox deduplication key.
   */
  public buildKey(consumer: string, eventId: string): string {
    return `library:inbox:${consumer}:${eventId}`;
  }

  /**
   * Executes a handler idempotently.
   * If the event was already processed, execution is skipped (`ALREADY_COMPLETED`).
   * If the event is currently being processed by another worker, execution is skipped (`IN_FLIGHT`).
   * If execution throws an error, the processing lease is cleared immediately so retries can proceed.
   */
  async executeIdempotent<T>(
    options: IdempotentConsumerOptions<T>,
  ): Promise<IdempotentResult<T>> {
    const {
      consumer,
      eventId,
      leaseTtlSeconds = 300, // 5 minutes processing lock lease
      retentionTtlSeconds = 86400, // 24 hours completed state retention
      handler,
    } = options;

    const key = this.buildKey(consumer, eventId);

    // 1. Check if already processed or in-flight in Redis / Memory
    const claim = await this.tryAcquireProcessingLease(
      key,
      leaseTtlSeconds,
    );

    if (!claim.acquired) {
      this.logger.debug(
        `[IdempotentConsumer] Event ${eventId} for consumer "${consumer}" skipped (${claim.reason}).`,
      );
      return {
        executed: false,
        skipped: true,
        reason: claim.reason,
      };
    }

    // 2. Acquired processing lease - execute handler
    try {
      const result = await handler();

      // 3. Mark completed with retention TTL
      await this.markCompleted(key, retentionTtlSeconds);

      return {
        executed: true,
        skipped: false,
        result,
      };
    } catch (err) {
      // 4. On failure, clear lease so BullMQ retry can execute
      await this.releaseLease(key);
      this.logger.warn(
        `[IdempotentConsumer] Event ${eventId} failed during execution. Processing lease released for retry.`,
      );
      throw err;
    }
  }

  /**
   * Checks whether an event has already been successfully processed by this consumer.
   */
  async isProcessed(consumer: string, eventId: string): Promise<boolean> {
    const key = this.buildKey(consumer, eventId);

    // 1. Check in-memory store
    const memEntry = this.getMemoryEntry(key);
    if (memEntry && memEntry.status === 'completed') {
      return true;
    }

    // 2. Check Redis if available
    if (this.redis && this.redis.isReady()) {
      try {
        const client = this.redis.getClient();
        if (client) {
          const raw = await client.get(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            return parsed.status === 'completed';
          }
        }
      } catch (err: any) {
        this.logger.debug(`Error checking Redis for ${key}: ${err.message}`);
      }
    }

    return false;
  }

  /**
   * Resets / deletes the inbox record for a specific consumer and event.
   */
  async reset(consumer: string, eventId: string): Promise<void> {
    const key = this.buildKey(consumer, eventId);
    this.memoryStore.delete(key);

    if (this.redis && this.redis.isReady()) {
      try {
        const client = this.redis.getClient();
        if (client) {
          await client.del(key);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to reset Redis inbox key ${key}: ${err.message}`);
      }
    }
  }

  /**
   * Clears the in-memory store (primarily for unit tests).
   */
  clearMemoryStore(): void {
    this.memoryStore.clear();
  }

  // ─── Internal Lease & State Management ─────────────────────────────────────

  private async tryAcquireProcessingLease(
    key: string,
    leaseTtlSeconds: number,
  ): Promise<{ acquired: boolean; reason?: 'ALREADY_COMPLETED' | 'IN_FLIGHT' }> {
    const now = Date.now();

    // 1. Remote Redis path (Distributed atomic lock)
    if (this.redis && this.redis.isReady()) {
      const client = this.redis.getClient();
      if (client) {
        try {
          const leasePayload = JSON.stringify({
            status: 'processing',
            startedAt: now,
          });

          // Atomic SET ... NX EX
          const setRes = await client.set(
            key,
            leasePayload,
            'EX',
            leaseTtlSeconds,
            'NX',
          );

          if (setRes === 'OK') {
            // Successfully acquired distributed lease
            this.setMemoryEntry(key, 'processing', leaseTtlSeconds);
            return { acquired: true };
          }

          // Key already exists — inspect current status
          const existingRaw = await client.get(key);
          if (existingRaw) {
            try {
              const existing = JSON.parse(existingRaw);
              if (existing.status === 'completed') {
                this.setMemoryEntry(key, 'completed', 86400);
                return { acquired: false, reason: 'ALREADY_COMPLETED' };
              }
              if (existing.status === 'processing') {
                this.setMemoryEntry(key, 'processing', leaseTtlSeconds);
                return { acquired: false, reason: 'IN_FLIGHT' };
              }
            } catch {
              // Corrupted JSON, treat as in-flight
              return { acquired: false, reason: 'IN_FLIGHT' };
            }
          }
        } catch (err: any) {
          this.logger.warn(
            `Redis atomic lease acquisition failed (${err.message}). Falling back to memory store.`,
          );
        }
      }
    }

    // 2. In-Memory Fallback Path
    const memEntry = this.getMemoryEntry(key);
    if (memEntry) {
      if (memEntry.status === 'completed') {
        return { acquired: false, reason: 'ALREADY_COMPLETED' };
      }
      if (memEntry.status === 'processing') {
        return { acquired: false, reason: 'IN_FLIGHT' };
      }
    }

    // Acquire in memory
    this.setMemoryEntry(key, 'processing', leaseTtlSeconds);
    return { acquired: true };
  }

  private async markCompleted(
    key: string,
    retentionTtlSeconds: number,
  ): Promise<void> {
    const completedPayload = JSON.stringify({
      status: 'completed',
      completedAt: Date.now(),
    });

    this.setMemoryEntry(key, 'completed', retentionTtlSeconds);

    if (this.redis && this.redis.isReady()) {
      const client = this.redis.getClient();
      if (client) {
        try {
          await client.set(
            key,
            completedPayload,
            'EX',
            retentionTtlSeconds,
          );
        } catch (err: any) {
          this.logger.warn(`Failed to mark event completed in Redis: ${err.message}`);
        }
      }
    }
  }

  private async releaseLease(key: string): Promise<void> {
    this.memoryStore.delete(key);

    if (this.redis && this.redis.isReady()) {
      const client = this.redis.getClient();
      if (client) {
        try {
          await client.del(key);
        } catch (err: any) {
          this.logger.warn(`Failed to release lease in Redis: ${err.message}`);
        }
      }
    }
  }

  private getMemoryEntry(key: string): MemoryInboxEntry | null {
    const entry = this.memoryStore.get(key);
    if (!entry) return null;

    if (entry.expiresAt < Date.now()) {
      this.memoryStore.delete(key);
      return null;
    }

    return entry;
  }

  private setMemoryEntry(
    key: string,
    status: 'processing' | 'completed',
    ttlSeconds: number,
  ): void {
    if (this.memoryStore.size >= IdempotentConsumerService.MAX_MEMORY_STORE_SIZE) {
      const now = Date.now();
      for (const [k, v] of this.memoryStore.entries()) {
        if (v.expiresAt < now) {
          this.memoryStore.delete(k);
        }
      }
      while (
        this.memoryStore.size >= IdempotentConsumerService.MAX_MEMORY_STORE_SIZE
      ) {
        const oldestKey = this.memoryStore.keys().next().value;
        if (!oldestKey) break;
        this.memoryStore.delete(oldestKey);
      }
    }

    this.memoryStore.set(key, {
      status,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }
}
