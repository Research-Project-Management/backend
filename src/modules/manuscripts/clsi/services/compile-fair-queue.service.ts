/**
 * modules/manuscripts/clsi/services/compile-fair-queue.service.ts
 * Application Service: Fair-Queue & Per-Tenant Fair Semaphore orchestrator for LaTeX compilation in CLSI.
 */

import * as os from 'os';
import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import {
  FairSemaphore,
  SemaphoreStats,
  SemaphoreQueueFullError,
  SemaphoreWaitTimeoutError,
  SemaphoreAbortedError,
  CompileRateLimitExceededError,
} from '../domain/fair-semaphore.domain';

export interface InFlightCompileSession {
  projectId: string;
  userId?: string;
  abortController: AbortController;
  startedAt: number;
  settled: Promise<void>;
}

export interface CompileQueueConfig {
  maxCompilesPerMinute?: number;
  minIntervalBetweenCompilesMs?: number;
  maxConcurrentCompiles?: number;
  maxQueueLength?: number;
  maxQueueWaitMs?: number;
  supersedeGraceMs?: number;
}

@Injectable()
export class CompileFairQueue implements OnModuleDestroy {
  private readonly logger = new Logger(CompileFairQueue.name);
  private readonly inFlightCompiles = new Map<string, InFlightCompileSession>();
  private readonly compileTimestamps = new Map<string, number[]>();

  private readonly slots: FairSemaphore;
  private readonly maxPerMinute: number;
  private readonly minIntervalMs: number;
  private readonly supersedeGraceMs: number;

  constructor(@Optional() config?: CompileQueueConfig) {
    this.maxPerMinute = config?.maxCompilesPerMinute ?? 20;
    this.minIntervalMs = config?.minIntervalBetweenCompilesMs ?? 400;
    this.supersedeGraceMs = config?.supersedeGraceMs ?? 3000;

    const cpus = typeof os.cpus === 'function' ? os.cpus().length : 2;
    const capacity = Math.max(
      1,
      Math.floor(config?.maxConcurrentCompiles ?? Math.max(2, cpus - 1)),
    );
    this.slots = new FairSemaphore(
      capacity,
      config?.maxQueueLength ?? 64,
      config?.maxQueueWaitMs ?? 90_000,
    );
  }

  public stats(): SemaphoreStats & { inFlightProjects: number } {
    return {
      ...this.slots.stats(),
      inFlightProjects: this.inFlightCompiles.size,
    };
  }

  public onModuleDestroy(): void {
    for (const session of this.inFlightCompiles.values()) {
      session.abortController.abort();
    }
    this.inFlightCompiles.clear();
    this.compileTimestamps.clear();
  }

  public async schedule<T>(
    projectId: string,
    userId: string | undefined,
    realtimeService: RealtimeFacade | undefined,
    executeFn: (
      signal: AbortSignal,
      onLogChunk: (chunk: string) => void,
    ) => Promise<T>,
    options?: { priority?: 'manual' | 'auto' },
  ): Promise<T> {
    // Load shedding: when queue is over 75% full, drop auto-compiles gracefully to preserve slots for manual compiles
    if (options?.priority === 'auto' && this.slots.stats().waiting > 40) {
      throw new HttpException(
        'Auto-compilation shed under high queue contention to prioritize manual builds',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.checkRateLimit(projectId);

    const existing = this.inFlightCompiles.get(projectId);
    const abortController = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    const session: InFlightCompileSession = {
      projectId,
      userId,
      abortController,
      startedAt: Date.now(),
      settled,
    };
    this.inFlightCompiles.set(projectId, session);

    let release: (() => void) | undefined;
    try {
      if (existing) {
        this.logger.log(
          `[Single-Flight] Superseding compile for project "${projectId}" (started ${Date.now() - existing.startedAt}ms ago) to prioritize newest build`,
        );
        existing.abortController.abort();

        realtimeService?.broadcastCompileProgress(projectId, {
          status: 'queued',
          logs: [
            '[CLSI Queue] Previous compilation cancelled: newer compile request superseded it.',
          ],
        });

        await this.waitSettled(existing.settled, this.supersedeGraceMs);
      }

      const fast = this.slots.tryAcquire();
      if (fast) {
        release = fast;
      } else {
        try {
          release = await this.slots.acquire(
            userId || projectId,
            abortController.signal,
          );
        } catch (err) {
          throw this.toHttpException(err, projectId);
        }
      }

      if (abortController.signal.aborted) {
        throw this.toHttpException(new SemaphoreAbortedError(), projectId);
      }

      const onLogChunk = (chunk: string) => {
        if (abortController.signal.aborted) return;
        realtimeService?.broadcastCompileProgress(projectId, {
          status: 'compiling',
          logs: [chunk],
        });
      };

      realtimeService?.broadcastCompileProgress(projectId, {
        status: 'compiling',
        logs: ['[CLSI Queue] Compilation started...'],
      });

      return await executeFn(abortController.signal, onLogChunk);
    } finally {
      release?.();
      if (this.inFlightCompiles.get(projectId) === session) {
        this.inFlightCompiles.delete(projectId);
      }
      markSettled();
    }
  }

  public cancel(projectId: string): boolean {
    const session = this.inFlightCompiles.get(projectId);
    if (session) {
      session.abortController.abort();
      this.logger.log(
        `Manually cancelled compilation for project "${projectId}"`,
      );
      return true;
    }
    return false;
  }

  public isInFlight(projectId: string): boolean {
    return this.inFlightCompiles.has(projectId);
  }

  private async waitSettled(settled: Promise<void>, graceMs: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private toHttpException(err: unknown, projectId: string): Error {
    if (err instanceof SemaphoreQueueFullError) {
      this.logger.warn(
        `[Backpressure] Compile queue full (${err.maxQueue}) – rejecting project "${projectId}"`,
      );
      return new HttpException(
        'Compilation queue is currently at capacity. Please try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (err instanceof SemaphoreWaitTimeoutError) {
      return new HttpException(
        'Compilation request timed out waiting in queue. Please try again.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (err instanceof SemaphoreAbortedError) {
      return new HttpException(
        'Compilation superseded by a newer request',
        HttpStatus.CONFLICT,
      );
    }
    if (err instanceof CompileRateLimitExceededError) {
      return new HttpException(err.message, HttpStatus.TOO_MANY_REQUESTS);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private checkRateLimit(projectId: string): void {
    const now = Date.now();
    let timestamps = this.compileTimestamps.get(projectId);
    if (!timestamps) {
      timestamps = [];
      this.compileTimestamps.set(projectId, timestamps);
    }

    const windowStart = now - 60000;
    timestamps = timestamps.filter((t) => t > windowStart);
    this.compileTimestamps.set(projectId, timestamps);

    if (this.compileTimestamps.size > 500) {
      this.pruneStaleTimestamps(windowStart);
    }

    if (timestamps.length >= this.maxPerMinute) {
      throw this.toHttpException(
        new CompileRateLimitExceededError(this.maxPerMinute),
        projectId,
      );
    }

    const lastCompile = timestamps[timestamps.length - 1];
    if (lastCompile && now - lastCompile < this.minIntervalMs) {
      this.logger.debug(
        `[Debounce] Project "${projectId}" requested compile within debounce window (${now - lastCompile}ms < ${this.minIntervalMs}ms). Single-flight cancellation will handle build supersession.`,
      );
    }

    timestamps.push(now);
  }

  private pruneStaleTimestamps(windowStart: number): void {
    for (const [id, ts] of this.compileTimestamps.entries()) {
      if (ts.length === 0 || ts.every((t) => t <= windowStart)) {
        this.compileTimestamps.delete(id);
      }
    }
  }
}
