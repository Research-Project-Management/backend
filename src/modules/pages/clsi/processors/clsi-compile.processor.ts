/**
 * modules/manuscripts/clsi/processors/clsi-compile.processor.ts
 *
 * BullMQ Worker Processor for asynchronous LaTeX compilation tasks.
 * Executes on background worker nodes to isolate compute-heavy compiler workloads
 * from the HTTP API / live-editing event loops.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MANUSCRIPT_CLSI_QUEUE } from '@/core/infrastructure/queue/bullmq.config';
import { getDefaultResourceGovernor } from '@/core/infrastructure/resource/system-resource-governor';
import { ClsiService, ClsiCompileResult } from '../services/clsi.service';
import { CompilePageDto } from '../dto/clsi.dto';

export interface ClsiCompileJobData {
  dto: CompilePageDto;
  userId?: string;
  authorizedProjectId?: string;
}

const resolvedWorkerConcurrency =
  Number(process.env.CLSI_WORKER_CONCURRENCY) ||
  getDefaultResourceGovernor().getTierBudgets().workerConcurrency;

@Processor(MANUSCRIPT_CLSI_QUEUE, { concurrency: resolvedWorkerConcurrency })
export class ClsiCompileProcessor extends WorkerHost {
  private readonly logger = new Logger(ClsiCompileProcessor.name);

  constructor(private readonly clsiService: ClsiService) {
    super();
  }

  public async process(
    job: Job<ClsiCompileJobData>,
  ): Promise<ClsiCompileResult> {
    const projectId =
      job.data.authorizedProjectId || job.data.dto.spaceId || 'unknown';

    this.logger.log(
      `[ClsiCompileProcessor] Processing job ${job.id} for project ${projectId}`,
    );

    return await this.clsiService.compileInline(
      job.data.dto,
      job.data.userId,
      job.data.authorizedProjectId,
    );
  }
}
