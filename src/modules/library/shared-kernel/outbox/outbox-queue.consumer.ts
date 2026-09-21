import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  LIBRARY_OUTBOX_QUEUE,
  LIBRARY_OUTBOX_JOB,
} from './outbox.constants';
import { OutboxWorker } from './outbox.worker';

@Processor(LIBRARY_OUTBOX_QUEUE, { concurrency: 5 })
export class OutboxQueueConsumer
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(OutboxQueueConsumer.name);

  constructor(private readonly outboxWorker: OutboxWorker) {
    super();
  }

  onApplicationBootstrap() {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`Outbox BullMQ Worker connection notice: ${err.message}`);
      });
      this.logger.log(
        `OutboxQueueConsumer registered with BullMQ on queue: ${LIBRARY_OUTBOX_QUEUE} (concurrency: 5)`,
      );
    } catch {
      // ignore
    }
  }

  async process(job: Job<{ eventId: string }>): Promise<void> {
    if (job.name !== LIBRARY_OUTBOX_JOB && job.name !== '__default__') {
      this.logger.debug(`Ignoring unknown job name: ${job.name}`);
      return;
    }

    const { eventId } = job.data;
    if (!eventId) return;

    await this.outboxWorker.processEventById(eventId);
  }
}