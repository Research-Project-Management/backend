import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  AI_JOB_DELETE_FILE,
  AI_JOB_INGEST_FILE,
  AI_KNOWLEDGE_QUEUE,
} from '../../ai.constant';
import { getDefaultResourceGovernor } from '@/core/infrastructure/resource/system-resource-governor';
import { KnowledgeIngestService } from '../services/ingest.service';
import type { KnowledgeFileJobData } from '../types/knowledge.type';

const resolvedAiKnowledgeConcurrency =
  Number(process.env.AI_KNOWLEDGE_CONCURRENCY) ||
  getDefaultResourceGovernor().getTierBudgets().aiKnowledgeConcurrency;

@Processor(AI_KNOWLEDGE_QUEUE, { concurrency: resolvedAiKnowledgeConcurrency })
export class KnowledgeQueueProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(KnowledgeQueueProcessor.name);

  constructor(private readonly ingestService: KnowledgeIngestService) {
    super();
  }

  onApplicationBootstrap(): void {
    try {
      this.worker?.on('error', (err) => {
        this.logger.warn(`AI Knowledge worker error: ${err.message}`);
      });
    } catch {
      // Worker disabled in lightweight test bootstrap
    }
  }

  async process(job: Job<unknown>): Promise<void> {
    if (job.name === AI_JOB_DELETE_FILE) {
      const data = job.data as {
        fileId: string;
        authorId: string;
        projectId?: string | null;
      };
      await this.ingestService.removeStorageFileKnowledge(data);
      return;
    }

    if (job.name === AI_JOB_INGEST_FILE) {
      await this.ingestService.ingestStorageFile(
        job.data as KnowledgeFileJobData,
      );
    }
  }
}
