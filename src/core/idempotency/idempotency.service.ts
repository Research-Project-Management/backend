import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisCacheService } from '../cache/redis-cache.service';
import {
  IdempotencyCheckResult,
  SaveIdempotencyResultInput,
} from './idempotency.types';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly DEFAULT_TTL_SEC = 86_400; // 24 hours

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Checks if an idempotency key is currently in-progress or completed
   */
  async checkKey(
    idempotencyKey: string,
    workspaceId: string,
  ): Promise<IdempotencyCheckResult> {
    // 1. Fast check via Redis
    const redisKey = `flux:idemp:${workspaceId}:${idempotencyKey}`;
    if (this.redisCache) {
      try {
        const cached = await this.redisCache.get<{
          status: string;
          statusCode: number;
          responseBody: unknown;
        }>(redisKey);
        if (cached) {
          if (cached.status === 'in_progress') {
            return { isDuplicate: true, inProgress: true };
          }
          return {
            isDuplicate: true,
            inProgress: false,
            statusCode: cached.statusCode,
            responseBody: cached.responseBody,
          };
        }
      } catch (err: any) {
        this.logger.debug(`Redis idempotency check error: ${err.message}`);
      }
    }

    // 2. Check Database Record
    const record = await (this.prisma as any).idempotencyRecord.findUnique({
      where: { idempotencyKey },
    });

    if (record) {
      if (record.expiresAt < new Date()) {
        await (this.prisma as any).idempotencyRecord.delete({
          where: { idempotencyKey },
        });
        return { isDuplicate: false, inProgress: false };
      }

      if (record.status === 'in_progress') {
        return { isDuplicate: true, inProgress: true };
      }

      return {
        isDuplicate: true,
        inProgress: false,
        statusCode: record.statusCode || 200,
        responseBody: record.responseBody,
      };
    }

    return { isDuplicate: false, inProgress: false };
  }

  /**
   * Sets in-progress lock
   */
  async lockKey(
    idempotencyKey: string,
    workspaceId: string,
    requestHash: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.DEFAULT_TTL_SEC * 1000);

    // Save to DB
    await (this.prisma as any).idempotencyRecord.upsert({
      where: { idempotencyKey },
      update: {
        status: 'in_progress',
        requestHash,
        expiresAt,
      },
      create: {
        idempotencyKey,
        workspaceId,
        requestHash,
        status: 'in_progress',
        expiresAt,
      },
    });

    // Save to Redis
    const redisKey = `flux:idemp:${workspaceId}:${idempotencyKey}`;
    if (this.redisCache) {
      try {
        await this.redisCache.set(redisKey, { status: 'in_progress' }, 300); // 5 min in-progress lock
      } catch (err: any) {
        this.logger.debug(`Redis idempotency lock error: ${err.message}`);
      }
    }
  }

  /**
   * Saves completed execution result
   */
  async saveResult(input: SaveIdempotencyResultInput): Promise<void> {
    const ttl = input.ttlSeconds || this.DEFAULT_TTL_SEC;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await (this.prisma as any).idempotencyRecord.update({
      where: { idempotencyKey: input.idempotencyKey },
      data: {
        status: 'succeeded',
        statusCode: input.statusCode,
        responseBody: input.responseBody as any,
        expiresAt,
      },
    });

    const redisKey = `flux:idemp:${input.workspaceId}:${input.idempotencyKey}`;
    if (this.redisCache) {
      try {
        await this.redisCache.set(
          redisKey,
          {
            status: 'succeeded',
            statusCode: input.statusCode,
            responseBody: input.responseBody,
          },
          ttl,
        );
      } catch (err: any) {
        this.logger.debug(`Redis idempotency save error: ${err.message}`);
      }
    }
  }

  /**
   * Clears key on execution failure to allow immediate client retry
   */
  async unlockKey(idempotencyKey: string, workspaceId: string): Promise<void> {
    try {
      await (this.prisma as any).idempotencyRecord.deleteMany({
        where: { idempotencyKey },
      });
    } catch {
      // Ignore if record already deleted
    }

    const redisKey = `flux:idemp:${workspaceId}:${idempotencyKey}`;
    if (this.redisCache) {
      try {
        await this.redisCache.del(redisKey);
      } catch {
        // Ignore
      }
    }
  }
}
