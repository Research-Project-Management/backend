import { Injectable, Logger, Optional } from '@nestjs/common';
import { CoreRepository } from '@/modules/work-item/core/core.repository';
import { RedisCacheService } from '@/core';
import { WORK_ITEM_REDIS_KEYS } from '@/modules/work-item/common/constants/redis.constant';

export interface NextIdentifierResult {
  identifier: string;
  sequenceNumber: number;
}

@Injectable()
export class IdHandler {
  private readonly logger = new Logger(IdHandler.name);
  private readonly initLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly coreRepository: CoreRepository,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  async nextIdentifier(projectId: string): Promise<NextIdentifierResult> {
    const prefix = await this.coreRepository.findProjectPrefix(projectId);
    const sequenceNumber = await this.getNextSequence(projectId);

    return {
      identifier: `${prefix}-${sequenceNumber}`,
      sequenceNumber,
    };
  }

  private async getNextSequence(projectId: string): Promise<number> {
    if (this.cache) {
      try {
        const key = WORK_ITEM_REDIS_KEYS.sequence(projectId);
        const exists = await this.cache.exists(key);
        if (!exists) {
          let initPromise = this.initLocks.get(projectId);
          if (!initPromise) {
            initPromise = (async () => {
              try {
                const maxSeq = await this.coreRepository.getMaxSequence(projectId);
                if (typeof this.cache?.setNx === 'function') {
                  await this.cache.setNx(key, maxSeq.toString());
                } else {
                  const stillMissing = !(await this.cache?.exists(key));
                  if (stillMissing) {
                    await this.cache?.set(key, maxSeq.toString());
                  }
                }
              } finally {
                this.initLocks.delete(projectId);
              }
            })();
            this.initLocks.set(projectId, initPromise);
          }
          await initPromise;
        }
        const next = await this.cache.incr(key);
        if (next > 0) {
          if (typeof this.coreRepository.syncProjectSequence === 'function') {
            void this.coreRepository
              .syncProjectSequence(projectId, next)
              .catch(() => null);
          }
          return next;
        }
      } catch (err) {
        this.logger.warn(
          `Sequence counter cache fallback for ${projectId}: ${(err as Error).message}`,
        );
      }
    }

    if (typeof this.coreRepository.allocateNextSequence === 'function') {
      const allocated = await this.coreRepository.allocateNextSequence(projectId);
      if (allocated > 0) return allocated;
    }

    const maxSeq = await this.coreRepository.getMaxSequence(projectId);
    return maxSeq + 1;
  }
}
