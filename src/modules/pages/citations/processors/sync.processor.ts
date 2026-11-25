/**
 * citations/processors/citation-sync.processor.ts
 * BullMQ Worker Processor executing heavy library-to-bib sync jobs off the HTTP thread.
 */

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CitationsService } from '../services/citations.service';
import { BibMutationResponseDto } from '../dto/citations.dto';
import {
  CITATION_SYNC_QUEUE,
  CitationSyncJobPayload,
} from '../services/sync.service';

@Processor(CITATION_SYNC_QUEUE, { concurrency: 4 })
export class CitationSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(CitationSyncProcessor.name);

  constructor(private readonly citationsService: CitationsService) {
    super();
  }

  public async process(
    job: Job<CitationSyncJobPayload, BibMutationResponseDto>,
  ): Promise<BibMutationResponseDto> {
    const { spaceId, userId, dto, pageId } = job.data;
    this.logger.log(
      `Processing citation sync job ${job.id} for space=${spaceId} collection=${dto.collectionId}`,
    );

    await job.updateProgress(10);
    const result = await this.citationsService.syncLibraryCollection(
      spaceId,
      userId,
      dto,
      pageId,
    );
    await job.updateProgress(100);

    return result;
  }
}
