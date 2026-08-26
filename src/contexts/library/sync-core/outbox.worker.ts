import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../core/database/prisma.service';
import { OutboxStatus, OutboxEvent } from '@prisma/client';

export interface OutboxDispatchHandler {
  handle(event: OutboxEvent): Promise<void>;
}

@Injectable()
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);
  private handlers = new Map<string, OutboxDispatchHandler>();
  private readonly maxRetries = 5;

  constructor(private readonly prisma: PrismaService) {}

  registerHandler(eventType: string, handler: OutboxDispatchHandler) {
    this.handlers.set(eventType, handler);
  }

  async processPendingEvents(batchSize: number = 50): Promise<{
    processed: number;
    failed: number;
    deadLettered: number;
  }> {
    const events = await this.prisma.outboxEvent.findMany({
      where: {
        status: OutboxStatus.PENDING,
        scheduledAt: {
          lte: new Date(),
        },
      },
      orderBy: [{ createdAt: 'asc' }],
      take: batchSize,
    });

    let processed = 0;
    let failed = 0;
    let deadLettered = 0;

    for (const event of events) {
      try {
        const handler = this.handlers.get(event.eventType);
        if (handler) {
          await handler.handle(event);
        } else {
          this.logger.debug(
            `No handler registered for event ${event.eventType}; marked as processed`,
          );
        }

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: OutboxStatus.PUBLISHED,
            processedAt: new Date(),
          },
        });
        processed += 1;
      } catch (err: any) {
        const newRetryCount = event.retryCount + 1;
        if (newRetryCount >= this.maxRetries) {
          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status: OutboxStatus.FAILED,
              retryCount: newRetryCount,
              error: err.message || 'Exceeded maximum retry attempts',
            },
          });
          deadLettered += 1;
        } else {
          // Exponential backoff: 2^retries seconds
          const delaySec = Math.pow(2, newRetryCount);
          const nextSchedule = new Date(Date.now() + delaySec * 1000);

          await this.prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              retryCount: newRetryCount,
              error: err.message,
              scheduledAt: nextSchedule,
            },
          });
          failed += 1;
        }
      }
    }

    return { processed, failed, deadLettered };
  }
}
