import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisCacheService } from '../redis/redis.service';
import { Prisma } from '@prisma/client';
import {
  IdempotencyCheckResult,
  SaveIdempotencyResultInput,
} from '../../http/contracts/idempotency.type';

@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);
  private readonly DEFAULT_TTL_SEC = 86_400; // 24 hours

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  private getRedisKey(
    idempotencyKey: string,
    userId: string,
    projectId?: string,
  ): string {
    const scopePrefix = projectId ? `proj:${projectId}` : `user:${userId}`;
    return `flux:idemp:${scopePrefix}:${idempotencyKey}`;
  }

  /**
   * Checks if an idempotency key is currently in-progress or completed
   */
  async checkKey(
    idempotencyKey: string,
    userId: string,
    projectId?: string,
  ): Promise<IdempotencyCheckResult> {
    // 1. Fast check via Redis
    const redisKey = this.getRedisKey(idempotencyKey, userId, projectId);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis idempotency check error: ${msg}`);
      }
    }

    // 2. Check Database Record using compound unique constraint [userId, idempotencyKey]
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: {
        userId_idempotencyKey: {
          userId,
          idempotencyKey,
        },
      },
    });

    if (record) {
      if (record.expiresAt < new Date()) {
        await this.prisma.idempotencyRecord.delete({
          where: { id: record.id },
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
   * Sets in-progress lock atomically
   */
  async lockKey(
    idempotencyKey: string,
    userId: string,
    requestHash: string,
    projectId?: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + this.DEFAULT_TTL_SEC * 1000);

    // Save to DB atomically using compound unique constraint [userId, idempotencyKey]
    await this.prisma.idempotencyRecord.upsert({
      where: {
        userId_idempotencyKey: {
          userId,
          idempotencyKey,
        },
      },
      update: {
        status: 'in_progress',
        requestHash,
        expiresAt,
        projectId: projectId ?? null,
      },
      create: {
        idempotencyKey,
        userId,
        projectId: projectId ?? null,
        requestHash,
        status: 'in_progress',
        expiresAt,
      },
    });

    // Save to Redis
    const redisKey = this.getRedisKey(idempotencyKey, userId, projectId);
    if (this.redisCache) {
      try {
        await this.redisCache.set(redisKey, { status: 'in_progress' }, 300); // 5 min in-progress lock
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis idempotency lock error: ${msg}`);
      }
    }
  }

  /**
   * Saves completed execution result atomically
   */
  async saveResult(input: SaveIdempotencyResultInput): Promise<void> {
    const ttl = input.ttlSeconds || this.DEFAULT_TTL_SEC;
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.prisma.idempotencyRecord.upsert({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      update: {
        status: 'succeeded',
        statusCode: input.statusCode,
        responseBody:
          (input.responseBody as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        expiresAt,
      },
      create: {
        idempotencyKey: input.idempotencyKey,
        userId: input.userId,
        projectId: input.projectId ?? null,
        requestHash: input.requestHash,
        statusCode: input.statusCode,
        responseBody:
          (input.responseBody as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        status: 'succeeded',
        expiresAt,
      },
    });

    const redisKey = this.getRedisKey(
      input.idempotencyKey,
      input.userId,
      input.projectId,
    );
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Redis idempotency save error: ${msg}`);
      }
    }
  }

  /**
   * Clears key on execution failure to allow immediate client retry
   */
  async unlockKey(
    idempotencyKey: string,
    userId: string,
    projectId?: string,
  ): Promise<void> {
    try {
      await this.prisma.idempotencyRecord.deleteMany({
        where: {
          userId,
          projectId: projectId || null,
          idempotencyKey,
        },
      });
    } catch {
      // Ignore if record already deleted
    }

    const redisKey = this.getRedisKey(idempotencyKey, userId, projectId);
    if (this.redisCache) {
      try {
        await this.redisCache.del(redisKey);
      } catch {
        // Ignore
      }
    }
  }
}
