import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { getErrorMessage } from '@/core';
import {
  AI_JOB_DELETE_FILE,
  AI_JOB_INGEST_FILE,
  AI_KNOWLEDGE_QUEUE,
} from '../../ai.constant';
import type { KnowledgeFileJobData } from '../types/knowledge.type';

@Injectable()
export class KnowledgeQueueProducer {
  private readonly logger = new Logger(KnowledgeQueueProducer.name);

  constructor(
    @Optional()
    @InjectQueue(AI_KNOWLEDGE_QUEUE)
    private readonly queue?: Queue,
  ) {
    if (this.queue && typeof this.queue.on === 'function') {
      this.queue.on('error', (err: Error) => {
        this.logger.warn(
          `AI Knowledge Queue connection notice: ${err.message}`,
        );
      });
    }
  }

  async enqueueIngest(data: KnowledgeFileJobData): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.add(AI_JOB_INGEST_FILE, data, {
        jobId: `ai-ingest-${data.fileId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      });
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to enqueue ingest job for ${data.fileId}: ${getErrorMessage(err)}`,
      );
      return false;
    }
  }

  async enqueueDelete(params: {
    fileId: string;
    authorId: string;
    projectId?: string | null;
  }): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.add(AI_JOB_DELETE_FILE, params, {
        jobId: `ai-delete-${params.fileId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 500,
        removeOnFail: 2000,
      });
      return true;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to enqueue delete job for ${params.fileId}: ${getErrorMessage(err)}`,
      );
      return false;
    }
  }
}
