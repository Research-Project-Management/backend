import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { isUUID } from 'class-validator';
import { deriveProjectIdentifierPrefix } from '../utils/work-item.util';
import { WORK_ITEM_REDIS_KEYS } from '../constants/redis-keys.constant';

export interface NextIdentifierResult {
  identifier: string;
  sequenceNumber: number;
}

@Injectable()
export class IdHandler {
  private readonly logger = new Logger(IdHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async nextIdentifier(projectId: string): Promise<NextIdentifierResult> {
    const prefix = await this.getProjectPrefix(projectId);
    const sequenceNumber = await this.getNextSequence(projectId);

    return {
      identifier: `${prefix}-${sequenceNumber}`,
      sequenceNumber,
    };
  }

  private async getProjectPrefix(projectId: string): Promise<string> {
    const where = isUUID(projectId)
      ? { id: projectId, deletedAt: null }
      : {
          identifier: { equals: projectId, mode: 'insensitive' as const },
          deletedAt: null,
        };

    const project = await this.prisma.project
      .findFirst({
        where,
        select: { identifier: true, name: true },
      })
      .catch(() => null);

    return deriveProjectIdentifierPrefix(project?.identifier, project?.name);
  }

  private async getNextSequence(projectId: string): Promise<number> {
    if (this.cache) {
      try {
        const key = WORK_ITEM_REDIS_KEYS.sequence(projectId);
        const exists = await this.cache.exists(key);
        if (!exists) {
          const maxSeq = await this.getMaxSequenceFromDb(projectId);
          await this.cache.set(key, maxSeq.toString());
        }
        const next = await this.cache.incr(key);
        if (next > 0) {
          return next;
        }
      } catch (err) {
        this.logger.warn(
          `Sequence counter cache fallback for ${projectId}: ${(err as Error).message}`,
        );
      }
    }

    const maxSeq = await this.getMaxSequenceFromDb(projectId);
    return maxSeq + 1;
  }

  private async getMaxSequenceFromDb(projectId: string): Promise<number> {
    const lastWorkItem = await this.prisma.workItem.findFirst({
      where: { projectId },
      orderBy: { sequenceNumber: 'desc' },
      select: { sequenceNumber: true },
    });

    if (lastWorkItem?.sequenceNumber) {
      return lastWorkItem.sequenceNumber;
    }

    const project = await this.prisma.project
      .findUnique({
        where: { id: projectId },
        select: { workItemSequence: true },
      })
      .catch(() => null);

    return project?.workItemSequence ?? 0;
  }
}

export const WorkItemIdHandler = IdHandler;
export type WorkItemIdHandler = IdHandler;
