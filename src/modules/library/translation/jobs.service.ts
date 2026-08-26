import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { TranslationService } from './translation.service';
import { IngestionState } from './jobs.state';
import type {
  BatchIngestDto,
  IngestDocumentDto,
  IngestionJobStatus,
  IngestionJobItemStatus,
} from './dto/translation.dto';

/**
 * JobsService — Durable Batch Job Queue with Retry, Exponential Backoff & Provenance Tracking.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  /** In-process fallback store when Redis is unavailable */
  private readonly localJobs = new Map<string, IngestionJobStatus>();
  private readonly activeJobAbortControllers = new Map<
    string,
    AbortController
  >();

  private readonly JOB_TTL_SECONDS = 86400; // 24 hours
  private readonly JOB_KEY_PREFIX = 'ingestion:job:';
  private readonly BATCH_CONCURRENCY = 4;
  private readonly MAX_ITEM_ATTEMPTS = 3;

  constructor(
    private readonly ingestionService: TranslationService,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  async persistJob(job: IngestionJobStatus): Promise<void> {
    job.updatedAt = new Date().toISOString();
    this.localJobs.set(job.jobId, job);
    if (this.redisCache?.isReady()) {
      await this.redisCache.set(
        `${this.JOB_KEY_PREFIX}${job.jobId}`,
        job,
        this.JOB_TTL_SECONDS,
      );
    }
  }

  async loadJob(jobId: string): Promise<IngestionJobStatus | undefined> {
    if (this.redisCache?.isReady()) {
      const redisJob = await this.redisCache.get<IngestionJobStatus>(
        `${this.JOB_KEY_PREFIX}${jobId}`,
      );
      if (redisJob) return redisJob;
    }
    return this.localJobs.get(jobId);
  }

  /**
   * Enqueues a durable asynchronous batch ingestion job.
   */
  async createAsyncBatchJob(
    userId: string,
    dto: BatchIngestDto,
  ): Promise<{ jobId: string; status: string; total: number }> {
    const jobId = randomUUID();
    const itemsDto = dto.items || [];
    const workspaceId = itemsDto[0]?.workspaceId || 'default';

    const jobItems: IngestionJobItemStatus[] = itemsDto.map((input, index) => ({
      index,
      input,
      state: IngestionState.DISCOVERED,
      status: 'pending',
      attempts: 0,
      maxAttempts: this.MAX_ITEM_ATTEMPTS,
    }));

    const job: IngestionJobStatus = {
      jobId,
      workspaceId,
      userId,
      status: 'processing',
      total: itemsDto.length,
      processed: 0,
      successCount: 0,
      failedCount: 0,
      progressPercentage: 0,
      items: jobItems,
      successful: [],
      failed: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await this.persistJob(job);

    const abortController = new AbortController();
    this.activeJobAbortControllers.set(jobId, abortController);

    // Launch worker execution in background
    setImmediate(() => {
      void (async () => {
        try {
          await this.processJob(job, abortController.signal);
        } catch (err) {
          this.logger.error(`Error in async ingestion job ${jobId}:`, err);
        } finally {
          this.activeJobAbortControllers.delete(jobId);
        }
      })();
    });

    return { jobId, status: 'processing', total: itemsDto.length };
  }

  /**
   * Durable worker loop: executes items in chunks, applies retry with exponential backoff for recoverable errors.
   */
  private async processJob(
    job: IngestionJobStatus,
    signal: AbortSignal,
  ): Promise<void> {
    const items = job.items || [];

    for (let i = 0; i < items.length; i += this.BATCH_CONCURRENCY) {
      if (signal.aborted || job.status === 'cancelled') {
        this.logger.warn(`Ingestion Job ${job.jobId} aborted by cancellation.`);
        break;
      }

      const chunk = items.slice(i, i + this.BATCH_CONCURRENCY);

      await Promise.all(
        chunk.map(async (itemStatus) => {
          if (itemStatus.status === 'success') return;

          await this.processSingleItemWithRetry(job, itemStatus, signal);
        }),
      );

      // Re-calculate aggregate stats
      job.processed = items.filter(
        (it) =>
          it.status === 'success' ||
          it.status === 'failed_unrecoverable' ||
          (it.status === 'failed_recoverable' && it.attempts >= it.maxAttempts),
      ).length;

      job.successCount = items.filter((it) => it.status === 'success').length;
      job.failedCount = items.filter(
        (it) =>
          it.status === 'failed_unrecoverable' ||
          (it.status === 'failed_recoverable' && it.attempts >= it.maxAttempts),
      ).length;

      job.progressPercentage =
        job.total > 0 ? Math.round((job.processed / job.total) * 100) : 100;

      await this.persistJob(job);
    }

    if (job.status !== 'cancelled') {
      job.status =
        job.failedCount === job.total && job.total > 0 ? 'failed' : 'completed';
      job.completedAt = new Date().toISOString();
      await this.persistJob(job);

      this.logger.log(
        `Async Ingestion Job ${job.jobId} finished (${job.successCount}/${job.total} success, ${job.failedCount} failed)`,
      );
    }
  }

  private async processSingleItemWithRetry(
    job: IngestionJobStatus,
    itemStatus: IngestionJobItemStatus,
    signal: AbortSignal,
  ): Promise<void> {
    while (
      itemStatus.attempts < itemStatus.maxAttempts &&
      itemStatus.status !== 'success' &&
      !signal.aborted
    ) {
      itemStatus.attempts++;
      itemStatus.lastAttemptAt = new Date().toISOString();
      itemStatus.status = 'processing';
      itemStatus.state = IngestionState.FETCHING_PRIMARY;

      try {
        const result = await this.ingestionService.ingest(
          job.userId,
          itemStatus.input,
        );

        itemStatus.status = 'success';
        itemStatus.state = IngestionState.PROMOTED;
        itemStatus.result = result;
        itemStatus.error = undefined;

        job.successful.push(result);
        return;
      } catch (err: any) {
        const errMsg = err?.message || 'Unknown ingestion error';
        const recoverable = this.isRecoverableError(err);

        itemStatus.error = errMsg;

        if (recoverable && itemStatus.attempts < itemStatus.maxAttempts) {
          itemStatus.status = 'failed_recoverable';
          itemStatus.state = IngestionState.FAILED_RECOVERABLE;

          const delayMs = this.calculateBackoffMs(itemStatus.attempts);
          itemStatus.nextRetryAt = new Date(Date.now() + delayMs).toISOString();

          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          itemStatus.status = 'failed_unrecoverable';
          itemStatus.state = IngestionState.FAILED_UNRECOVERABLE;

          job.failed.push({
            item: itemStatus.input,
            error: errMsg,
            attempts: itemStatus.attempts,
          });
          return;
        }
      }
    }
  }

  /**
   * Determines whether an error is transient/recoverable (rate limit, timeout, 503)
   */
  private isRecoverableError(err: any): boolean {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    const status = err.status || err.statusCode;

    if (status === 429 || status === 503 || status === 504 || status === 502) {
      return true;
    }

    if (
      msg.includes('timeout') ||
      msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('rate limit') ||
      msg.includes('temporarily unavailable')
    ) {
      return true;
    }

    return false;
  }

  /**
   * Exponential backoff calculation: min(1000 * 2^(attempt - 1), 15000) ms
   */
  private calculateBackoffMs(attempt: number): number {
    const base = 500 * Math.pow(2, attempt - 1);
    return Math.min(base, 15000);
  }

  /**
   * Poll status of an async batch ingestion job.
   */
  async getJobStatus(
    jobId: string,
    userId: string,
  ): Promise<IngestionJobStatus> {
    const job = await this.loadJob(jobId);
    if (!job)
      throw new BadRequestException(`Ingestion job with ID ${jobId} not found`);
    if (job.userId !== userId) {
      throw new ForbiddenException('You do not have access to this job');
    }
    return job;
  }

  listUserJobs(userId: string): IngestionJobStatus[] {
    const jobs: IngestionJobStatus[] = [];
    for (const job of this.localJobs.values()) {
      if (job.userId === userId) jobs.push(job);
    }
    return jobs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async cancelJob(
    jobId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const job = await this.loadJob(jobId);
    if (!job)
      throw new BadRequestException(`Ingestion job with ID ${jobId} not found`);
    if (job.userId !== userId) {
      throw new ForbiddenException('You do not have access to this job');
    }

    job.status = 'cancelled';
    await this.persistJob(job);

    const controller = this.activeJobAbortControllers.get(jobId);
    if (controller) {
      controller.abort();
      this.activeJobAbortControllers.delete(jobId);
    }

    return { success: true };
  }
}

export const TranslationJobService = JobsService;
export { JobsService as IngestionJobService };
