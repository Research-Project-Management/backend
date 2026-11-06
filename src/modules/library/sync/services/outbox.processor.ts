import {
  Inject,
  Logger,
  Optional,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
  OUTBOX_REGISTRY_PORT,
} from '@/modules/library/core';

export interface IOutboxEventProcessor {
  processEventById(
    eventId: string,
    options?: { rethrowOnRetryableFailure?: boolean },
  ): Promise<boolean>;
}

@Processor(LIBRARY_OUTBOX_QUEUE, { concurrency: 5 })
export class OutboxQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxQueueConsumer.name);

  constructor(
    @Optional()
    @Inject(OUTBOX_REGISTRY_PORT)
    private readonly outboxWorker?: IOutboxEventProcessor,
  ) {
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
    if (!eventId || !this.outboxWorker) return;

    await this.outboxWorker.processEventById(eventId, {
      rethrowOnRetryableFailure: true,
    });
  }
}

export { OutboxQueueConsumer as OutboxBullProcessor };
