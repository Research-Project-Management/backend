/**
 * clsi/core/pipeline/compile-fair-queue.ts
 *
 * Fair-Queue & Concurrency Limiter for LaTeX compilation in CLSI (Overleaf Parity).
 *
 * Layered guarantees:
 *  1. Rate limit        – sliding window per project (protects against request floods).
 *  2. Single-flight     – at most one compile per project; a newer request supersedes the
 *                         older one (aborting it, or dropping it from the queue), and the
 *                         newer one waits for the older one to actually unwind instead of
 *                         guessing with a fixed sleep.
 *  3. Global capacity   – at most `maxConcurrentCompiles` latexmk processes run at once
 *                         across ALL projects (bounded CPU/RAM).
 *  4. Fair scheduling   – excess requests wait in per-user FIFO queues served round-robin,
 *                         with a bounded queue length and bounded waiting time (fail fast
 *                         with 503 + Retry-After semantics rather than unbounded latency).
 *  5. Live log streaming to WebSocket clients.
 */

import * as os from 'os';
import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RealtimeService } from '@/modules/realtime/realtime.service';
import {
  FairSemaphore,
  SemaphoreAbortedError,
  SemaphoreQueueFullError,
  SemaphoreStats,
  SemaphoreWaitTimeoutError,
} from './fair-semaphore';

export interface InFlightCompileSession {
  projectId: string;
  userId?: string;
  abortController: AbortController;
  startedAt: number;
  /** Resolves once this session has fully unwound (slot released, cleanup done). */
  settled: Promise<void>;
}

export interface CompileQueueConfig {
  maxCompilesPerMinute?: number;
  minIntervalBetweenCompilesMs?: number;
  /** Max simultaneous compiles across all projects. Default: max(2, cpus - 1). */
  maxConcurrentCompiles?: number;
  /** Max requests allowed to wait for a slot. Default: 64. */
  maxQueueLength?: number;
  /** Max time a request may wait for a slot. Default: 90s. */
  maxQueueWaitMs?: number;
  /** Max time a newer request waits for the superseded one to unwind. Default: 3s. */
  supersedeGraceMs?: number;
}

@Injectable()
export class CompileFairQueue {
  private readonly logger = new Logger(CompileFairQueue.name);

  // Active compile per project: projectId -> InFlightCompileSession
  private readonly inFlightCompiles = new Map<string, InFlightCompileSession>();

  // Sliding window timestamps for rate limiting: projectId -> number[] (timestamps)
  private readonly compileTimestamps = new Map<string, number[]>();

  private readonly slots: FairSemaphore;
  private readonly maxPerMinute: number;
  private readonly minIntervalMs: number;
  private readonly supersedeGraceMs: number;

  constructor(config?: CompileQueueConfig) {
    this.maxPerMinute = config?.maxCompilesPerMinute ?? 20; // 20 compiles per min max
    this.minIntervalMs = config?.minIntervalBetweenCompilesMs ?? 400; // 400ms debounce
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

  /** Snapshot for health/metrics endpoints. */
  public stats(): SemaphoreStats & { inFlightProjects: number } {
    return {
      ...this.slots.stats(),
      inFlightProjects: this.inFlightCompiles.size,
    };
  }

  /**
   * Schedules a compilation with single-flight guarantee, fair rate-limiting,
   * bounded global concurrency, and live log streaming.
   */
  public async schedule<T>(
    projectId: string,
    userId: string | undefined,
    realtimeService: RealtimeService | undefined,
    executeFn: (
      signal: AbortSignal,
      onLogChunk: (chunk: string) => void,
    ) => Promise<T>,
  ): Promise<T> {
    // 1. Enforce sliding-window rate limit
    this.checkRateLimit(projectId);

    // 2. Register the new session SYNCHRONOUSLY (so isInFlight/cancel see it at once),
    //    superseding any previous session of the same project.
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

        // Notify clients that the previous run was superseded
        realtimeService?.broadcastCompileProgress(projectId, {
          status: 'queued',
          logs: [
            '[CLSI Queue] Previous compilation cancelled: newer compile request superseded it.',
          ],
        });

        // Wait for the older run to really unwind (releases project lock + slot) rather
        // than sleeping a guessed duration; bounded so a wedged job cannot block us.
        await this.waitSettled(existing.settled, this.supersedeGraceMs);
      }

      // 3. Fair, bounded global concurrency (sync fast path when a slot is free)
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

      // Stream log chunks via WebSocket
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
      // Clean up session if this controller is still the active one
      if (this.inFlightCompiles.get(projectId) === session) {
        this.inFlightCompiles.delete(projectId);
      }
      markSettled();
    }
  }

  /**
   * Cancel an ongoing (or queued) compilation on demand.
   */
  public cancel(projectId: string): boolean {
    const session = this.inFlightCompiles.get(projectId);
    if (session) {
      session.abortController.abort();
      this.inFlightCompiles.delete(projectId);
      this.logger.log(
        `Manually cancelled compilation for project "${projectId}"`,
      );
      return true;
    }
    return false;
  }

  /**
   * Query in-flight compilation status.
   */
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
    return err instanceof Error ? err : new Error(String(err));
  }

  private checkRateLimit(projectId: string): void {
    const now = Date.now();
    let timestamps = this.compileTimestamps.get(projectId);
    if (!timestamps) {
      timestamps = [];
      this.compileTimestamps.set(projectId, timestamps);
    }

    // Filter to last 60 seconds
    const windowStart = now - 60000;
    timestamps = timestamps.filter((t) => t > windowStart);
    this.compileTimestamps.set(projectId, timestamps);

    // Prune stale empty project entries to prevent memory leaks over time
    if (this.compileTimestamps.size > 500) {
      this.pruneStaleTimestamps(windowStart);
    }

    if (timestamps.length >= this.maxPerMinute) {
      throw new HttpException(
        `Compilation rate limit exceeded (${this.maxPerMinute} runs/min). Please wait a moment before recompiling.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Check minimum interval
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
