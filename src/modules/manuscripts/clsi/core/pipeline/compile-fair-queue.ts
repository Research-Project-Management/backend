/**
 * clsi/core/pipeline/compile-fair-queue.ts
 *
 * Fair-Queue & Concurrency Limiter for LaTeX compilation in CLSI (Overleaf Parity).
 * Features:
 * - 1 concurrent compile per project: automatically cancels/aborts obsolete builds
 *   when a newer compile request arrives for the same project.
 * - Sliding-window rate limiter per project/user to protect server CPU from DOS.
 * - Real-time compile log chunk streaming to WebSocket clients.
 */

import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { RealtimeService } from '@/modules/realtime/realtime.service';

export interface InFlightCompileSession {
  projectId: string;
  userId?: string;
  abortController: AbortController;
  startedAt: number;
}

export interface CompileQueueConfig {
  maxCompilesPerMinute?: number;
  minIntervalBetweenCompilesMs?: number;
}

@Injectable()
export class CompileFairQueue {
  private readonly logger = new Logger(CompileFairQueue.name);

  // Active compile per project: projectId -> InFlightCompileSession
  private readonly inFlightCompiles = new Map<string, InFlightCompileSession>();

  // Sliding window timestamps for rate limiting: projectId -> number[] (timestamps)
  private readonly compileTimestamps = new Map<string, number[]>();

  private readonly maxPerMinute: number;
  private readonly minIntervalMs: number;

  constructor(config?: CompileQueueConfig) {
    this.maxPerMinute = config?.maxCompilesPerMinute ?? 20; // 20 compiles per min max
    this.minIntervalMs = config?.minIntervalBetweenCompilesMs ?? 400; // 400ms debounce
  }

  /**
   * Schedules a compilation with single-flight guarantee, fair rate-limiting,
   * and live log streaming.
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

    // 2. Single-Flight Concurrency: If another compile is in flight for this project, abort it
    const existing = this.inFlightCompiles.get(projectId);
    if (existing) {
      this.logger.log(
        `[Single-Flight] Cancelling obsolete compile for project "${projectId}" (started ${Date.now() - existing.startedAt}ms ago) to prioritize newest build`,
      );
      existing.abortController.abort();
      this.inFlightCompiles.delete(projectId);

      // Notify clients that the previous run was superseded
      realtimeService?.broadcastCompileProgress(projectId, {
        status: 'queued',
        logs: [
          '[CLSI Queue] Previous compilation cancelled: newer compile request superseded it.',
        ],
      });

      // Brief delay to allow host OS / filesystem lock to release cleanly
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    // 3. Register fresh compile session
    const abortController = new AbortController();
    const session: InFlightCompileSession = {
      projectId,
      userId,
      abortController,
      startedAt: Date.now(),
    };
    this.inFlightCompiles.set(projectId, session);

    // Stream log chunks via WebSocket
    const onLogChunk = (chunk: string) => {
      if (abortController.signal.aborted) return;
      realtimeService?.broadcastCompileProgress(projectId, {
        status: 'compiling',
        logs: [chunk],
      });
    };

    try {
      realtimeService?.broadcastCompileProgress(projectId, {
        status: 'compiling',
        logs: ['[CLSI Queue] Compilation started...'],
      });

      const result = await executeFn(abortController.signal, onLogChunk);
      return result;
    } finally {
      // Clean up session if this controller is still the active one
      if (
        this.inFlightCompiles.get(projectId)?.abortController ===
        abortController
      ) {
        this.inFlightCompiles.delete(projectId);
      }
    }
  }

  /**
   * Cancel an ongoing compilation on demand.
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
        `Giới hạn biên dịch vượt quá (${this.maxPerMinute} lần/phút). Vui lòng đợi vài giây trước khi biên dịch lại.`,
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
