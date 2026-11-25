import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { getQueueConfig, QUEUE_NAMES, type QueueName } from './queue.config';

export interface QueueMetricSnapshot {
  active: number;
  waiting: number;
  delayed: number;
  failed: number;
  completed: number;
  status: 'healthy' | 'degraded';
}

/**
 * Lightweight read-only BullMQ inspector for GET /health/queues.
 * Lazily opens Queue handles on first inspection and closes them cleanly on shutdown.
 */
@Injectable()
export class QueueHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueHealthService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly config: ConfigService) {}

  private getOrCreateQueue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const bullConfig = getQueueConfig(this.config);
    const queue = new Queue(name, {
      connection: bullConfig.connection,
    });
    this.queues.set(name, queue);
    return queue;
  }

  async getAllQueueMetrics(): Promise<Record<QueueName, QueueMetricSnapshot>> {
    const entries = await Promise.all(
      QUEUE_NAMES.map(
        async (name): Promise<[QueueName, QueueMetricSnapshot]> => {
          try {
            const queue = this.getOrCreateQueue(name);
            const counts = await queue.getJobCounts(
              'active',
              'waiting',
              'delayed',
              'failed',
              'completed',
            );
            return [
              name,
              {
                active: counts.active ?? 0,
                waiting: counts.waiting ?? 0,
                delayed: counts.delayed ?? 0,
                failed: counts.failed ?? 0,
                completed: counts.completed ?? 0,
                status: 'healthy',
              },
            ];
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Failed to read queue metrics for ${name}: ${msg}`,
            );
            return [
              name,
              {
                active: 0,
                waiting: 0,
                delayed: 0,
                failed: 0,
                completed: 0,
                status: 'degraded',
              },
            ];
          }
        },
      ),
    );

    return Object.fromEntries(entries) as Record<
      QueueName,
      QueueMetricSnapshot
    >;
  }

  async onModuleDestroy(): Promise<void> {
    const closers = Array.from(this.queues.values()).map((q) =>
      q.close().catch(() => undefined),
    );
    this.queues.clear();
    await Promise.all(closers);
  }
}
