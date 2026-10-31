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
import { ClsiService, ClsiCompileResult } from '../services/clsi.service';
import { CompileManuscriptDto } from '../dto/clsi.dto';

export interface ClsiCompileJobData {
  dto: CompileManuscriptDto;
  userId?: string;
  authorizedProjectId?: string;
}

@Processor(MANUSCRIPT_CLSI_QUEUE, { concurrency: 2 })
export class ClsiCompileProcessor extends WorkerHost {
  private readonly logger = new Logger(ClsiCompileProcessor.name);

  constructor(private readonly clsiService: ClsiService) {
    super();
  }

  public async process(
    job: Job<ClsiCompileJobData>,
  ): Promise<ClsiCompileResult> {
    const projectId =
      job.data.authorizedProjectId ||
      job.data.dto.projectId ||
      'unknown';

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
