import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoreRepository } from '../core.repository';
import { RedisCacheService } from '@/core';
import { WORK_ITEM_REDIS_KEYS } from '../../common/constants/redis-keys.constant';

export interface NextIdentifierResult {
  identifier: string;
  sequenceNumber: number;
}

@Injectable()
export class IdHandler {
  private readonly logger = new Logger(IdHandler.name);

  constructor(
    private readonly repository: CoreRepository,
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
    return this.repository.findProjectPrefix(projectId);
  }

  private async getNextSequence(projectId: string): Promise<number> {
    if (this.cache) {
      try {
        const key = WORK_ITEM_REDIS_KEYS.sequence(projectId);
        const exists = await this.cache.exists(key);
        if (!exists) {
          const maxSeq = await this.repository.getMaxSequence(projectId);
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

    const maxSeq = await this.repository.getMaxSequence(projectId);
    return maxSeq + 1;
  }
}

export const WorkItemIdHandler = IdHandler;
export type WorkItemIdHandler = IdHandler;
