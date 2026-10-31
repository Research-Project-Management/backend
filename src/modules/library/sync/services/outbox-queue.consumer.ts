import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Job } from 'bullmq';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
} from '@/modules/library/sync/domain/outbox.domain';
import { OutboxWorker } from './outbox.worker';

@Processor(LIBRARY_OUTBOX_QUEUE, { concurrency: 5 })
export class OutboxQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxQueueConsumer.name);

  constructor(private readonly outboxWorker: OutboxWorker) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(
          `Outbox BullMQ Worker connection notice: ${err.message}`,
        );
      });
      this.logger.log(
        `OutboxQueueConsumer registered with BullMQ on queue: ${LIBRARY_OUTBOX_QUEUE} (concurrency: 5)`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`OutboxQueueConsumer worker listener skipped: ${msg}`);
    }
  }

  async onApplicationShutdown() {
    try {
      if (this.worker) {
        this.logger.log('Closing OutboxQueueConsumer worker on shutdown...');
        await this.worker.close();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Error closing OutboxQueueConsumer worker: ${msg}`);
    }
  }

  async process(
    job: Job<{ eventId: string; eventType?: string }>,
  ): Promise<void> {
    if (job.name !== LIBRARY_OUTBOX_JOB && job.name !== '__default__') {
      this.logger.debug(`Ignoring unknown job name: ${job.name}`);
      return;
    }

    const { eventId } = job.data;
    if (!eventId) return;

    await this.outboxWorker.processEventById(eventId, {
      rethrowOnRetryableFailure: true,
    });
  }
}
