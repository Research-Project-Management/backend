import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RedisCacheService } from '../cache/redis-cache.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EnqueueOutboxInput, OutboxDispatchResult } from './outbox.types';

/**
 * @deprecated Use `OutboxWorker` in `src/modules/library/sync/workers/outbox.worker.ts` instead.
 * `OutboxWorker` is the single authoritative distributed outbox processor with CAS lease claiming,
 * heartbeat renewal, recovery, dead-lettering, and typed event handlers.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  /**
   * Enqueues an outbox event within a Prisma transaction or standard context
   */
  async enqueue(
    input: EnqueueOutboxInput,
    tx?: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
  ) {
    const client = tx || this.prisma;
    return await (client as any).outboxEvent.create({
      data: {
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload as any,
        status: 'PENDING',
      },
    });
  }

  /**
   * Dispatches pending outbox events asynchronously
   */
  async dispatchPending(batchSize: number = 50): Promise<OutboxDispatchResult> {
    if (this.isProcessing) {
      return { processed: 0, errors: 0 };
    }

    this.isProcessing = true;
    let processedCount = 0;
    let errorCount = 0;

    try {
      const pendingEvents = await (this.prisma as any).outboxEvent.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: batchSize,
      });

      for (const event of pendingEvents) {
        try {
          // 1. Dispatch locally via EventEmitter2
          if (this.eventEmitter) {
            this.eventEmitter.emit(event.eventType, {
              eventId: event.id,
              aggregateId: event.aggregateId,
              payload: event.payload,
              createdAt: event.createdAt,
            });
          }

          // 2. Publish to Redis channel if Redis is active
          if (this.redisCache) {
            try {
              const client = (this.redisCache as any).client;
              if (client && typeof client.publish === 'function') {
                await client.publish(
                  `lib:events:${event.eventType}`,
                  JSON.stringify(event),
                );
              }
            } catch (redisErr: any) {
              this.logger.debug(
                `Redis publish skipped for ${event.id}: ${redisErr.message}`,
              );
            }
          }

          // 3. Mark event as PUBLISHED
          await (this.prisma as any).outboxEvent.update({
            where: { id: event.id },
            data: {
              status: 'PUBLISHED',
              processedAt: new Date(),
            },
          });
          processedCount++;
        } catch (err: any) {
          errorCount++;
          const newRetryCount = event.retryCount + 1;
          const isFinalFailure = newRetryCount >= 5;

          await (this.prisma as any).outboxEvent.update({
            where: { id: event.id },
            data: {
              status: isFinalFailure ? 'FAILED' : 'PENDING',
              retryCount: newRetryCount,
              error: err.message || 'Unknown dispatch error',
            },
          });
          this.logger.error(
            `Failed to dispatch Outbox Event ${event.id}: ${err.message}`,
          );
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return { processed: processedCount, errors: errorCount };
  }
}
