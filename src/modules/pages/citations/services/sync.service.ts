/**
 * citations/adapters/library-sync.adapter.ts
 * Dedicated Adapter (SRP) for fetching BibTeX streams from Zotero, Mendeley, or Flux Library.
 */

import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { LIBRARY_FACADE, ILibraryFacade } from '@/modules/library';
import { ILibrarySyncPort } from '../domain/citations.ports';

@Injectable()
export class LibrarySyncAdapter implements ILibrarySyncPort {
  private readonly logger = new Logger(LibrarySyncAdapter.name);

  constructor(
    @Optional()
    private readonly integrationsService?: IntegrationsService,
    @Optional()
    @Inject(LIBRARY_FACADE)
    private readonly libraryFacade?: ILibraryFacade,
  ) {}

  public async fetchCollectionBibtex(
    userId: string,
    collectionId: string,
    spaceId?: string,
  ): Promise<string> {
    if (
      collectionId.startsWith('zotero:') ||
      collectionId.startsWith('group:')
    ) {
      const rawCollId = collectionId.startsWith('zotero:')
        ? collectionId.replace('zotero:', '')
        : collectionId;

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Zotero integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'zotero',
        rawCollId,
      );
      return res.bibtex;
    }

    if (collectionId.startsWith('mendeley:')) {
      const rawCollId = collectionId.replace('mendeley:', '');

      if (!this.integrationsService) {
        throw new ServiceUnavailableException(
          'Mendeley integration services are not configured',
        );
      }

      const res = await this.integrationsService.fetchRemoteCollectionBibtex(
        userId,
        'mendeley',
        rawCollId,
      );
      return res.bibtex;
    }

    if (this.libraryFacade) {
      try {
        const exportRes = await this.libraryFacade.exportLibrary(userId, {
          format: 'bibtex',
          collectionId,
          spaceId,
        });
        if (exportRes?.content !== undefined) {
          return exportRes.content;
        }
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to export collection BibTeX via LibraryFacade: ${(err as Error)?.message}`,
        );
      }
    }

    throw new NotFoundException(`Collection ${collectionId} not found`);
  }
}


/**
 * citations/services/citation-sync-queue.service.ts
 * Async BullMQ job producer and status tracker for large library syncs.
 */

import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { CITATION_SYNC_QUEUE } from '@/core/infrastructure/queue/bullmq.config';
import { SyncLibraryDto, BibMutationResponseDto } from '../dto/citations.dto';

export { CITATION_SYNC_QUEUE };

export interface CitationSyncJobPayload {
  spaceId: string;
  userId: string;
  dto: SyncLibraryDto;
  pageId?: string;
}

export interface CitationSyncJobStatusDto {
  jobId: string;
  state: string;
  progress?: number;
  result?: BibMutationResponseDto;
  failedReason?: string;
}

@Injectable()
export class CitationSyncQueueService {
  constructor(
    @Optional()
    @InjectQueue(CITATION_SYNC_QUEUE)
    private readonly syncQueue?: Queue<CitationSyncJobPayload, BibMutationResponseDto>,
  ) {}

  public isAvailable(): boolean {
    return Boolean(this.syncQueue);
  }

  public async enqueueSync(
    payload: CitationSyncJobPayload,
  ): Promise<{ jobId: string; status: 'queued' }> {
    if (!this.syncQueue) {
      throw new Error('Citation sync queue is not configured');
    }

    const dedupeKey = `sync:${payload.spaceId}:${payload.dto.collectionId}:${payload.dto.targetBibFile || 'references.bib'}`;
    const job = await this.syncQueue.add('sync-library', payload, {
      jobId: `${dedupeKey}:${Date.now()}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 86400, count: 500 },
    });

    return {
      jobId: String(job.id),
      status: 'queued',
    };
  }

  public async getJobStatus(jobId: string): Promise<CitationSyncJobStatusDto> {
    if (!this.syncQueue) {
      throw new NotFoundException(`Sync job ${jobId} not found`);
    }

    const job = await this.syncQueue.getJob(jobId);
    if (!job) {
      throw new NotFoundException(`Sync job ${jobId} not found`);
    }

    const state = await job.getState();
    return {
      jobId: String(job.id),
      state,
      progress: typeof job.progress === 'number' ? job.progress : undefined,
      result: state === 'completed' ? job.returnvalue : undefined,
      failedReason: state === 'failed' ? job.failedReason : undefined,
    };
  }
}

