import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisCacheService } from '../../../core/cache/redis-cache.service';
import { IngestionService } from './ingestion.service';
import type { BatchIngestDto, IngestionJobStatus } from './dto/ingestion.dto';

/**
 * IngestionJobService — Async batch job queue + Redis/in-memory job state.
 *
 * Extracted from IngestionService (C2 — Divergent Change refactor).
 * Owns exactly one concern: creating, persisting, and polling async ingestion jobs.
 *
 * State persistence strategy (dual-layer):
 *  - Redis (TTL 24h) when available: survives restarts, supports multi-instance polling.
 *  - In-process Map (fallback): local/dev environments without Redis.
 *
 * IngestionService delegates createAsyncBatchJob() and getJobStatus() to this service.
 * The actual item ingestion still runs via IngestionService.ingest() — this service
 * owns only the job lifecycle wrapper around those calls.
 */
@Injectable()
export class IngestionJobService {
  private readonly logger = new Logger(IngestionJobService.name);

  /** In-process fallback store when Redis is unavailable */
  private readonly localJobs = new Map<string, IngestionJobStatus>();
  private readonly JOB_TTL_SECONDS = 86400; // 24 hours
  private readonly JOB_KEY_PREFIX = 'ingestion:job:';
  private readonly BATCH_CONCURRENCY = 5;

  constructor(
    private readonly ingestionService: IngestionService,
    @Optional() private readonly redisCache?: RedisCacheService,
  ) {}

  async persistJob(job: IngestionJobStatus): Promise<void> {
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
   * Enqueues an asynchronous batch ingestion job.
   * Job state is persisted to Redis on every update so callers can poll progress across restarts.
   * Falls back to in-process Map when Redis is unavailable.
   */
  async createAsyncBatchJob(
    userId: string,
    dto: BatchIngestDto,
  ): Promise<{ jobId: string; status: string; total: number }> {
    const jobId = randomUUID();
    const items = dto.items || [];

    const job: IngestionJobStatus = {
      jobId,
      userId,
      status: 'processing',
      total: items.length,
      processed: 0,
      successCount: 0,
      failedCount: 0,
      progressPercentage: 0,
      successful: [],
      failed: [],
      createdAt: new Date().toISOString(),
    };

    await this.persistJob(job);

    setImmediate(async () => {
      for (let i = 0; i < items.length; i += this.BATCH_CONCURRENCY) {
        const chunk = items.slice(i, i + this.BATCH_CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map((item) => this.ingestionService.ingest(userId, item)),
        );
        for (let j = 0; j < results.length; j++) {
          const res = results[j];
          if (res.status === 'fulfilled') {
            job.successful.push(res.value);
            job.successCount++;
          } else {
            job.failed.push({
              item: chunk[j],
              error: (res.reason as Error)?.message || 'Failed to ingest item',
            });
            job.failedCount++;
          }
          job.processed++;
          job.progressPercentage = Math.round(
            (job.processed / job.total) * 100,
          );
        }
        await this.persistJob(job);
      }
      job.status = job.failedCount === job.total ? 'failed' : 'completed';
      job.completedAt = new Date().toISOString();
      await this.persistJob(job);
      this.logger.log(
        `Async Ingestion Job ${jobId} finished (${job.successCount}/${job.total} success)`,
      );
    });

    return { jobId, status: 'processing', total: items.length };
  }

  /**
   * Poll status of an async batch ingestion job.
   * Checks Redis first, then falls back to in-process Map.
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

  async listUserJobs(userId: string): Promise<IngestionJobStatus[]> {
    const jobs: IngestionJobStatus[] = [];
    for (const job of this.localJobs.values()) {
      if (job.userId === userId) jobs.push(job);
    }
    return jobs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  async cancelJob(jobId: string, userId: string): Promise<{ success: boolean }> {
    const job = await this.loadJob(jobId);
    if (!job)
      throw new BadRequestException(`Ingestion job with ID ${jobId} not found`);
    if (job.userId !== userId) {
      throw new ForbiddenException('You do not have access to this job');
    }
    // Mark as cancelled — actual processing cannot be stopped mid-flight
    // but the job record will no longer be considered active
    job.status = 'cancelled' as any;
    await this.persistJob(job);
    this.localJobs.delete(jobId);
    if (this.redisCache?.isReady()) {
      await this.redisCache.del(`${this.JOB_KEY_PREFIX}${jobId}`);
    }
    return { success: true };
  }
}
