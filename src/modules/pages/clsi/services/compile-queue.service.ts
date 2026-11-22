/**
 * modules/manuscripts/clsi/services/compile-queue.service.ts
 * Application Service: Fair-Queue & Per-Tenant Fair Semaphore orchestrator for LaTeX compilation in CLSI.
 */

import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { getDefaultResourceGovernor } from '@/core/infrastructure/resource/system-resource-governor';
import { RealtimeFacade } from '@/modules/realtime/realtime.facade';
import {
  CompilePriority,
  FairSemaphore,
  SemaphoreStats,
  SemaphoreQueueFullError,
  SemaphoreWaitTimeoutError,
  SemaphoreAbortedError,
  CompileRateLimitExceededError,
  AutoCompileShedError,
  CompileSupersededError,
} from '../domain/fair-semaphore';

interface SlotReservation {
  tenantKey: string;
  abortController: AbortController;
  promise: Promise<() => void>;
  claimed: boolean;
  abandoned: boolean;
}

export interface InFlightCompileSession {
  projectId: string;
  userId?: string;
  priority: CompilePriority;
  phase: 'queued' | 'running';
  fingerprint?: string;
  forceClean?: boolean;
  abortController: AbortController;
  slotReservation?: SlotReservation;
  resultPromise?: Promise<unknown>;
  startedAt: number;
  settled: Promise<void>;
}

export interface CompileScheduleOptions {
  priority?: CompilePriority;
  fingerprint?: string;
  forceClean?: boolean;
}

export interface CompileQueueConfig {
  maxCompilesPerMinute?: number;
  minIntervalBetweenCompilesMs?: number;
  maxConcurrentCompiles?: number;
  maxQueueLength?: number;
  maxQueueWaitMs?: number;
  supersedeGraceMs?: number;
  autoShedThreshold?: number;
  logChunkFlushIntervalMs?: number;
  maxLogChunkBytes?: number;
}

@Injectable()
export class CompileQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(CompileQueueService.name);
  private readonly inFlightCompiles = new Map<string, InFlightCompileSession>();
  private readonly compileTimestamps = new Map<string, number[]>();

  private readonly slots: FairSemaphore;
  private readonly maxPerMinute: number;
  private readonly minIntervalMs: number;
  private readonly supersedeGraceMs: number;
  private readonly autoShedThreshold: number;
  private readonly logChunkFlushIntervalMs: number;
  private readonly maxLogChunkBytes: number;

  constructor(@Optional() config?: CompileQueueConfig) {
    this.maxPerMinute = config?.maxCompilesPerMinute ?? 20;
    this.minIntervalMs = config?.minIntervalBetweenCompilesMs ?? 400;
    this.supersedeGraceMs = config?.supersedeGraceMs ?? 3000;
    this.logChunkFlushIntervalMs = config?.logChunkFlushIntervalMs ?? 300;
    this.maxLogChunkBytes = config?.maxLogChunkBytes ?? 4096;

    const governorConcurrency =
      getDefaultResourceGovernor().getTierBudgets().workerConcurrency;
    const capacity = Math.max(
      1,
      Math.floor(config?.maxConcurrentCompiles ?? governorConcurrency),
    );
    const maxQueueLength = config?.maxQueueLength ?? 64;
    this.autoShedThreshold =
      config?.autoShedThreshold ??
      Math.min(40, Math.floor(maxQueueLength * 0.75));
    this.slots = new FairSemaphore(
      capacity,
      maxQueueLength,
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
      if (session.slotReservation) {
        session.slotReservation.abandoned = true;
        session.slotReservation.abortController.abort();
      }
      session.abortController.abort();
    }
    this.inFlightCompiles.clear();
    this.compileTimestamps.clear();
  }

  /**
   * Registers the computed content fingerprint for the currently active compile
   * session of `projectId`, enabling subsequent identical requests to coalesce.
   */
  public registerFingerprint(projectId: string, fingerprint: string): void {
    const session = this.inFlightCompiles.get(projectId);
    if (session && fingerprint) {
      session.fingerprint = fingerprint;
    }
  }

  public async schedule<T>(
    projectId: string,
    userId: string | undefined,
    realtimeService: RealtimeFacade | undefined,
    executeFn: (
      signal: AbortSignal,
      onLogChunk: (chunk: string) => void,
    ) => Promise<T>,
    options?: CompileScheduleOptions,
  ): Promise<T> {
    const priority: CompilePriority = options?.priority ?? 'manual';
    const existing = this.inFlightCompiles.get(projectId);

    // 1. In-Flight Content-Fingerprint Coalescing:
    // If an identical build (same projectId + non-empty fingerprint, no forceClean) is already
    // queued or running, piggyback on its Promise instead of killing it and burning 2x CPU.
    if (
      existing &&
      !existing.abortController.signal.aborted &&
      !options?.forceClean &&
      !existing.forceClean &&
      options?.fingerprint &&
      existing.fingerprint === options.fingerprint &&
      existing.resultPromise
    ) {
      if (priority === 'manual' && existing.priority === 'auto') {
        existing.priority = 'manual';
        if (existing.phase === 'queued' && existing.slotReservation) {
          this.slots.promoteWaiterToManual(existing.slotReservation.tenantKey);
        }
      }
      this.logger.log(
        `[Coalesce] Joining in-flight compile for project "${projectId}" (fingerprint=${options.fingerprint.slice(0, 12)})`,
      );
      return (await existing.resultPromise) as T;
    }

    // 2. Load shedding: shed auto-compiles under high queue contention to preserve slots for manual builds
    const waitingCount = this.slots.stats().waiting;
    if (priority === 'auto' && waitingCount >= this.autoShedThreshold) {
      throw this.toHttpException(
        new AutoCompileShedError(waitingCount, this.autoShedThreshold),
        projectId,
      );
    }

    // 3. Rate-limit check:
    // If we are superseding a job that is STILL waiting in the queue (never started pdflatex),
    // replace its timestamp in-place rather than penalizing the project's rate limit.
    const supersedingQueuedOnly = Boolean(
      existing && existing.phase === 'queued',
    );
    this.checkRateLimit(projectId, supersedingQueuedOnly);

    const abortController = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));

    // Transfer wait-queue slot reservation if the previous session hasn't started running yet
    let inheritedReservation: SlotReservation | undefined;
    if (
      existing &&
      existing.phase === 'queued' &&
      existing.slotReservation &&
      !existing.slotReservation.abandoned
    ) {
      inheritedReservation = existing.slotReservation;
      existing.slotReservation = undefined;
      if (priority === 'manual' && existing.priority === 'auto') {
        this.slots.promoteWaiterToManual(inheritedReservation.tenantKey);
      }
    }

    const session: InFlightCompileSession = {
      projectId,
      userId,
      priority,
      phase: 'queued',
      fingerprint: options?.fingerprint,
      forceClean: options?.forceClean,
      abortController,
      slotReservation: inheritedReservation,
      startedAt: Date.now(),
      settled,
    };
    this.inFlightCompiles.set(projectId, session);

    let release: (() => void) | undefined;
    let pendingLogBuffer = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const clearFlushTimer = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      pendingLogBuffer = '';
    };
    const flushLogChunks = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (!pendingLogBuffer || abortController.signal.aborted) {
        pendingLogBuffer = '';
        return;
      }
      const payload = pendingLogBuffer;
      pendingLogBuffer = '';
      realtimeService?.broadcastCompileProgress(projectId, {
        status: 'compiling',
        logs: [payload],
      });
    };

    const runExecution = async (): Promise<T> => {
      try {
        if (existing) {
          this.logger.log(
            `[Single-Flight] Superseding ${existing.phase} compile for project "${projectId}" (started ${Date.now() - existing.startedAt}ms ago) to prioritize newest build`,
          );
          existing.abortController.abort();

          realtimeService?.broadcastCompileProgress(projectId, {
            status: 'queued',
            logs: [
              '[CLSI Queue] Previous compilation cancelled: newer compile request superseded it.',
            ],
          });

          // Only need to wait for process cleanup if the previous build had already acquired a slot and started running
          if (!inheritedReservation) {
            await this.waitSettled(existing.settled, this.supersedeGraceMs);
          }
        }

        if (inheritedReservation) {
          release = await this.awaitSlotReservation(
            inheritedReservation,
            abortController.signal,
            projectId,
          );
        } else {
          const fast = this.slots.tryAcquire();
          if (fast) {
            release = fast;
          } else {
            const reservation = this.createSlotReservation(
              userId || projectId,
              priority,
            );
            session.slotReservation = reservation;
            release = await this.awaitSlotReservation(
              reservation,
              abortController.signal,
              projectId,
            );
          }
        }

        session.phase = 'running';
        session.slotReservation = undefined;

        if (abortController.signal.aborted) {
          throw this.toHttpException(new SemaphoreAbortedError(), projectId);
        }

        const onLogChunk = (chunk: string) => {
          if (abortController.signal.aborted || !chunk) return;
          const combined = pendingLogBuffer + chunk;
          pendingLogBuffer =
            combined.length > this.maxLogChunkBytes
              ? combined.slice(combined.length - this.maxLogChunkBytes)
              : combined;
          if (!flushTimer) {
            flushTimer = setTimeout(
              flushLogChunks,
              this.logChunkFlushIntervalMs,
            );
            flushTimer.unref?.();
          }
        };

        realtimeService?.broadcastCompileProgress(projectId, {
          status: 'compiling',
          logs: ['[CLSI Queue] Compilation started...'],
        });

        return await executeFn(abortController.signal, onLogChunk);
      } finally {
        clearFlushTimer();
        if (session.slotReservation) {
          session.slotReservation.abandoned = true;
          session.slotReservation.abortController.abort();
          session.slotReservation = undefined;
        }
        release?.();
        if (this.inFlightCompiles.get(projectId) === session) {
          this.inFlightCompiles.delete(projectId);
        }
        markSettled();
      }
    };

    const executionPromise = runExecution();
    session.resultPromise = executionPromise;
    return await executionPromise;
  }

  public cancel(projectId: string): boolean {
    const session = this.inFlightCompiles.get(projectId);
    if (session) {
      if (session.slotReservation) {
        session.slotReservation.abandoned = true;
        session.slotReservation.abortController.abort();
        session.slotReservation = undefined;
      }
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

  private createSlotReservation(
    tenantKey: string,
    priority: CompilePriority,
  ): SlotReservation {
    const slotAbortController = new AbortController();
    const rawPromise = this.slots.acquire(
      tenantKey,
      slotAbortController.signal,
      priority,
    );
    const reservation: SlotReservation = {
      tenantKey,
      abortController: slotAbortController,
      promise: rawPromise,
      claimed: false,
      abandoned: false,
    };
    rawPromise.then(
      (rel) => {
        if (reservation.abandoned && !reservation.claimed) {
          rel();
        }
      },
      () => {},
    );
    return reservation;
  }

  private async awaitSlotReservation(
    reservation: SlotReservation,
    callerSignal: AbortSignal,
    projectId: string,
  ): Promise<() => void> {
    if (callerSignal.aborted) {
      throw this.toHttpException(new SemaphoreAbortedError(), projectId);
    }

    let onCallerAbort: (() => void) | undefined;
    const callerAbortPromise = new Promise<never>((_, reject) => {
      onCallerAbort = () => reject(new SemaphoreAbortedError());
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    });

    try {
      const rel = await Promise.race([reservation.promise, callerAbortPromise]);
      if (callerSignal.aborted) {
        // If caller was superseded/aborted at the exact tick the slot resolved,
        // only release if the reservation wasn't handed over to a newer session.
        if (reservation.abandoned) {
          rel();
        }
        throw new SemaphoreAbortedError();
      }
      reservation.claimed = true;
      return rel;
    } catch (err) {
      throw this.toHttpException(err, projectId);
    } finally {
      if (onCallerAbort) {
        callerSignal.removeEventListener('abort', onCallerAbort);
      }
    }
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
        {
          code: err.code,
          message:
            'Compilation queue is currently at capacity. Please try again in a moment.',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (err instanceof SemaphoreWaitTimeoutError) {
      return new HttpException(
        {
          code: err.code,
          message:
            'Compilation request timed out waiting in queue. Please try again.',
        },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (
      err instanceof SemaphoreAbortedError ||
      err instanceof CompileSupersededError
    ) {
      return new HttpException(
        {
          code: 'COMPILE_SUPERSEDED',
          message: 'Compilation superseded by a newer request',
        },
        HttpStatus.CONFLICT,
      );
    }
    if (err instanceof CompileRateLimitExceededError) {
      return new HttpException(
        {
          code: err.code,
          message: err.message,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (err instanceof AutoCompileShedError) {
      return new HttpException(
        {
          code: err.code,
          message: err.message,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private checkRateLimit(
    projectId: string,
    replaceLastTimestamp = false,
  ): void {
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

    if (replaceLastTimestamp && timestamps.length > 0) {
      timestamps[timestamps.length - 1] = now;
      return;
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

/** @deprecated Use CompileQueueService */
export { CompileQueueService as CompileFairQueue };
