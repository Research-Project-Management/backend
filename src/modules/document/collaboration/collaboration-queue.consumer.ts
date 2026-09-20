import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { VersionEventType } from '@prisma/client';
import {
  DOCUMENT_REDIS_KEYS,
  COLLABORATION_REDIS_KEYS,
} from '../page/constants/page-redis-keys.constant';
import {
  DOCUMENT_COLLABORATION_QUEUE,
  DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB,
  QueuedCheckpointJob,
} from './constants/collaboration-queue.constants';

/**
 * BullMQ Worker for Collaborative Checkpointing & Version History.
 * Offloads database version creation and cache invalidation from the WebSocket event loop.
 */
@Processor(DOCUMENT_COLLABORATION_QUEUE, { concurrency: 2 })
export class CollaborationQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(CollaborationQueueConsumer.name);

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly redis?: RedisCacheService,
  ) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Collaboration Worker notice: ${err.message}`);
      });
      this.logger.log(
        `CollaborationQueueConsumer registered with BullMQ on queue: ${DOCUMENT_COLLABORATION_QUEUE} (concurrency: 2)`,
      );
    } catch {
      // Non-blocking in standalone/test environments
    }
  }

  async process(job: Job<QueuedCheckpointJob>): Promise<void> {
    if (
      job.name !== DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB &&
      job.name !== '__default__'
    ) {
      this.logger.debug(`Ignoring unknown job: ${job.name}`);
      return;
    }

    const { pageId, content, savedById, label, editsCount } = job.data;
    this.logger.log(
      `[BullMQ] Processing collaborative checkpoint for page ${pageId} (${content.length} chars)`,
    );

    if (!this.prisma) return;

    try {
      await this.prisma.pageVersion.create({
        data: {
          pageId,
          content,
          savedById,
          eventType: VersionEventType.collaborative_checkpoint,
          label:
            label ||
            `Collaborative checkpoint (${editsCount ? `${editsCount} edits` : 'auto'})`,
        },
      });

      // Invalidate page versions cache & compact Redis oplog (cold storage absorption)
      if (this.redis) {
        await this.redis
          .del(DOCUMENT_REDIS_KEYS.pageVersions(pageId))
          .catch(() => {});
        const oplogKey = COLLABORATION_REDIS_KEYS.oplog(pageId);
        await this.redis
          .zremrangebyscore(oplogKey, '-inf', Date.now())
          .catch(() => {});
      }

      this.logger.log(
        `[BullMQ] Successfully created collaborative checkpoint for page ${pageId} and compacted oplog`,
      );
    } catch (err: any) {
      this.logger.error(
        `[BullMQ] Failed to persist collaborative checkpoint for ${pageId}: ${err?.message || err}`,
      );
      throw err; // Re-throw to trigger BullMQ retry policy
    }
  }
}
