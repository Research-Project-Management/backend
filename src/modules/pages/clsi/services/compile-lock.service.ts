/**
 * modules/pages/clsi/services/compile-lock.service.ts
 * Application Service: Overleaf-parity per-(spaceId, userId) Compile Lock &
 * Hardware-Adaptive Fail-Fast Concurrency Manager for LaTeX compilation in CLSI.
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
  AlreadyCompilingError,
  AutoCompileShedError,
  CompileAbortedError,
  CompileLockStats,
  CompilePriority,
  CompileRateLimitExceededError,
  CompileSupersededError,
  TooManyCompileRequestsError,
} from '../domain/errors';

/**
 * Citation: Overleaf `services/clsi/app/js/LockManager.js` (lines 9, 53-80).
 * Lock timeout equals maximum compile timeout plus 2 minutes (120,000ms).
 */
const DEFAULT_MAX_COMPILE_TIMEOUT_MS = 240_000;
const OVERLEAF_LOCK_EXPIRY_BUFFER_MS = 120_000;

/**
 * Memory footprint budget per active TeX Live (`latexmk` + `pdflatex`/`xelatex`) subprocess (~112 MiB),
 * paired with SystemResourceGovernor's 85% high-watermark ceiling and 2x CPU time-slicing factor
 * (matching Overleaf's 2x vCPU ratio: 32 slots on 16-vCPU spot, 64 slots on 32-vCPU c3d/c4d nodes).
 */
const AVG_LOCAL_TEX_SUBPROCESS_MEMORY_BYTES = 112 * 1024 * 1024; // 112 MiB per local TeX subprocess
const AVG_REMOTE_PROXY_COMPILE_MEMORY_BYTES = 32 * 1024 * 1024; // 32 MiB when proxying via CLSI_URL
const NODE_BASE_OVERHEAD_BYTES = 128 * 1024 * 1024; // 128 MiB reserved for Node runtime
const SYSTEM_MEMORY_HIGH_WATERMARK_RATIO = 0.85;
const CPU_OVERSUBSCRIPTION_FACTOR = 2; // 2 concurrent compile slots per CPU core (I/O + OS time-slicing)
const MIN_LIVE_FREE_MEMORY_FOR_NEW_COMPILE_BYTES = 96 * 1024 * 1024; // 96 MiB minimum real free RAM before spawning another compile

export interface ResolveCompileConcurrencyOptions {
  isRemoteProxy?: boolean;
}

export interface LiveCompileCapacityAssessment {
  readonly maxConcurrency: number;
  readonly hasLiveMemoryHeadroom: boolean;
  readonly liveFreeMemoryBytes: number;
  readonly effectiveMemoryLimitBytes: number;
}

/**
 * Dynamically computes the maximum concurrent LaTeX compilations from actual host/container
 * hardware resources (CPU cores via `os.availableParallelism()` and physical/cgroup RAM via
 * `SystemResourceGovernor.readHardwareSnapshot()`), scaling smoothly from 2-3 CPU / 4-6GB RAM
 * VPS deployments up to 32-64 CPU servers without hardcoded limits.
 */
export function resolveHardwareCompileConcurrencyLimit(
  options?: ResolveCompileConcurrencyOptions,
): number {
  const snap = getDefaultResourceGovernor().readHardwareSnapshot();
  const cpuCount = Math.max(1, snap.cpuCount || 1);

  const effectiveSystemMemoryBytes =
    snap.cgroupMemLimitBytes !== null && snap.cgroupMemLimitBytes > 0
      ? Math.min(snap.cgroupMemLimitBytes, snap.osTotalMemBytes)
      : snap.osTotalMemBytes;

  const isRemoteProxy =
    options?.isRemoteProxy ?? Boolean((process.env.CLSI_URL || '').trim());
  const perCompileMemoryBytes = isRemoteProxy
    ? AVG_REMOTE_PROXY_COMPILE_MEMORY_BYTES
    : AVG_LOCAL_TEX_SUBPROCESS_MEMORY_BYTES;

  const usableForCompilesBytes = Math.max(
    perCompileMemoryBytes,
    Math.floor(
      effectiveSystemMemoryBytes * SYSTEM_MEMORY_HIGH_WATERMARK_RATIO -
        NODE_BASE_OVERHEAD_BYTES,
    ),
  );

  const maxByCpu = Math.max(2, cpuCount * CPU_OVERSUBSCRIPTION_FACTOR);
  const maxByMemory = Math.max(
    1,
    Math.floor(usableForCompilesBytes / perCompileMemoryBytes),
  );

  return Math.max(1, Math.min(maxByCpu, maxByMemory));
}

/**
 * Evaluates live host/container hardware headroom right at compile time (not just once at boot):
 * - Reads real-time container memory usage (`/sys/fs/cgroup/memory.current` including all active
 *   `pdflatex`/`xelatex` child processes) or OS free memory (`os.freemem()`).
 * - If active compiles are already consuming real RAM and free headroom drops below 96 MiB (or >88% cgroup limit),
 *   sheds new concurrent requests immediately with 503 before the Linux OOM killer can terminate the container.
 */
export function assessLiveCompileCapacity(
  options?: ResolveCompileConcurrencyOptions,
): LiveCompileCapacityAssessment {
  const snap = getDefaultResourceGovernor().readHardwareSnapshot();
  const maxConcurrency = resolveHardwareCompileConcurrencyLimit(options);

  if (snap.cgroupMemLimitBytes !== null && snap.cgroupMemLimitBytes > 0) {
    const effectiveLimit = Math.min(
      snap.cgroupMemLimitBytes,
      snap.osTotalMemBytes,
    );
    const liveUsed =
      snap.cgroupMemUsedBytes !== null && snap.cgroupMemUsedBytes !== undefined
        ? snap.cgroupMemUsedBytes
        : snap.rssBytes;
    const liveFree = Math.max(0, effectiveLimit - liveUsed);
    const usageRatio = effectiveLimit > 0 ? liveUsed / effectiveLimit : 0;
    return {
      maxConcurrency,
      hasLiveMemoryHeadroom:
        liveFree >= MIN_LIVE_FREE_MEMORY_FOR_NEW_COMPILE_BYTES &&
        usageRatio < 0.88,
      liveFreeMemoryBytes: liveFree,
      effectiveMemoryLimitBytes: effectiveLimit,
    };
  }

  const liveFree =
    snap.osFreeMemBytes !== undefined
      ? snap.osFreeMemBytes
      : Math.max(0, snap.osTotalMemBytes - snap.rssBytes);
  return {
    maxConcurrency,
    hasLiveMemoryHeadroom:
      liveFree >= MIN_LIVE_FREE_MEMORY_FOR_NEW_COMPILE_BYTES,
    liveFreeMemoryBytes: liveFree,
    effectiveMemoryLimitBytes: snap.osTotalMemBytes,
  };
}

/**
 * Citation: Overleaf `services/clsi/app/js/CompileManager.js` (lines 51-57):
 * ```js
 * function getCompileName(spaceId, userId) {
 *   if (userId != null) {
 *     return `${spaceId}-${userId}`
 *   } else {
 *     return spaceId
 *   }
 * }
 * ```
 * Scopes compilation locks and rate-limit keys per `(spaceId, userId)` pair so two
 * different users in the same project can compile independently without blocking or
 * cancelling each other's builds.
 */
export function getCompileName(spaceId: string, userId?: string): string {
  if (userId != null && userId !== '') {
    return `${spaceId}-${userId}`;
  }
  return spaceId;
}

export interface InFlightCompileSession {
  compileKey: string;
  spaceId: string;
  userId?: string;
  priority: CompilePriority;
  abortController: AbortController;
  startedAt: number;
  expiresAt: number;
  settled: Promise<void>;
  isExpired(): boolean;
  waitForRelease(): Promise<void>;
}

export interface CompileLockOptions {
  priority?: CompilePriority;
  forceClean?: boolean;
}

export interface CompileLockConfig {
  maxCompilesPerMinute?: number;
  minIntervalBetweenCompilesMs?: number;
  maxConcurrentCompiles?: number;
  supersedeGraceMs?: number;
  lockTimeoutMs?: number;
  autoShedThreshold?: number;
  logChunkFlushIntervalMs?: number;
  maxLogChunkBytes?: number;
}

@Injectable()
export class CompileLockService implements OnModuleDestroy {
  private readonly logger = new Logger(CompileLockService.name);
  /**
   * Citation: Overleaf `services/clsi/app/js/LockManager.js` (`const LOCKS = new Map()`, lines 11-51).
   * Tracks active compilation locks per `(spaceId, userId)`:
   * - Overlapping requests for the same key are rejected immediately with `AlreadyCompilingError` (HTTP 423 Locked).
   * - Requests arriving when `locks.size >= compileConcurrencyLimit` (or live RAM headroom is exhausted)
   *   fail fast with `TooManyCompileRequestsError` (HTTP 503 Unavailable, `status: 'unavailable'`).
   */
  private readonly locks = new Map<string, InFlightCompileSession>();
  private readonly compileTimestamps = new Map<string, number[]>();

  private readonly compileConcurrencyLimit: number;
  private readonly maxPerMinute: number;
  private readonly minIntervalMs: number;
  private readonly supersedeGraceMs: number;
  private readonly lockTimeoutMs: number;
  private readonly autoShedThreshold: number;
  private readonly logChunkFlushIntervalMs: number;
  private readonly maxLogChunkBytes: number;

  constructor(@Optional() config?: CompileLockConfig) {
    this.maxPerMinute = config?.maxCompilesPerMinute ?? 20;
    this.minIntervalMs = config?.minIntervalBetweenCompilesMs ?? 1000;
    this.supersedeGraceMs = config?.supersedeGraceMs ?? 3000;
    this.lockTimeoutMs =
      config?.lockTimeoutMs ??
      DEFAULT_MAX_COMPILE_TIMEOUT_MS + OVERLEAF_LOCK_EXPIRY_BUFFER_MS;
    this.logChunkFlushIntervalMs = config?.logChunkFlushIntervalMs ?? 300;
    this.maxLogChunkBytes = config?.maxLogChunkBytes ?? 4096;

    const envConcurrency = Number(process.env.CLSI_MAX_CONCURRENT_COMPILES);
    const defaultConcurrency =
      Number.isFinite(envConcurrency) && envConcurrency >= 1
        ? Math.floor(envConcurrency)
        : resolveHardwareCompileConcurrencyLimit();

    this.compileConcurrencyLimit = Math.max(
      1,
      Math.floor(config?.maxConcurrentCompiles ?? defaultConcurrency),
    );
    this.autoShedThreshold =
      config?.autoShedThreshold ??
      Math.max(1, Math.floor(this.compileConcurrencyLimit * 0.75));
  }

  public stats(): CompileLockStats {
    this.pruneExpiredLocks();
    return {
      capacity: this.compileConcurrencyLimit,
      active: this.locks.size,
      inFlightProjects: this.locks.size,
    };
  }

  public onModuleDestroy(): void {
    for (const session of this.locks.values()) {
      session.abortController.abort();
    }
    this.locks.clear();
    this.compileTimestamps.clear();
  }

  private pruneExpiredLocks(): void {
    for (const [key, lock] of this.locks.entries()) {
      if (lock.isExpired()) {
        this.logger.warn(`Compile lock expired for "${key}"`);
        lock.abortController.abort();
        this.locks.delete(key);
      }
    }
  }

  /**
   * Citation: Overleaf `services/clsi/app/js/LockManager.js` (lines 39-51):
   * ```js
   * function checkConcurrencyLimit() {
   *   Metrics.gauge('concurrent_compile_requests', LOCKS.size)
   *   if (LOCKS.size <= Settings.compileConcurrencyLimit) {
   *     return
   *   }
   *   Metrics.inc('exceeded-compilier-concurrency-limit')
   *   throw new Errors.TooManyCompileRequestsError('too many concurrent compile requests')
   * }
   * ```
   */
  private checkConcurrencyLimit(spaceId: string): void {
    this.pruneExpiredLocks();
    if (this.locks.size >= this.compileConcurrencyLimit) {
      throw this.toHttpException(
        new TooManyCompileRequestsError('too many concurrent compile requests'),
        spaceId,
      );
    }

    // Live runtime memory pressure check: when at least 1 compile is already active,
    // verify real kernel/OS free memory (`/sys/fs/cgroup/memory.current` or `os.freemem()`)
    // before admitting another concurrent compile process.
    if (this.locks.size >= 1) {
      const liveCapacity = assessLiveCompileCapacity();
      if (!liveCapacity.hasLiveMemoryHeadroom) {
        this.logger.warn(
          `[LiveMemoryBackpressure] Shedding concurrent compile for "${spaceId}" (active=${this.locks.size}, freeMemMB=${Math.round(liveCapacity.liveFreeMemoryBytes / (1024 * 1024))})`,
        );
        throw this.toHttpException(
          new TooManyCompileRequestsError(
            'too many concurrent compile requests',
          ),
          spaceId,
        );
      }
    }
  }

  /**
   * Citation: Overleaf `services/clsi/app/js/CompileManager.js` (`doCompileWithLock`, lines 65-76).
   * Acquires the per-`(spaceId, userId)` compile lock, enforces fail-fast concurrency and
   * live memory headroom, and executes `executeFn` immediately with zero waiting queue.
   */
  public async runWithLock<T>(
    spaceId: string,
    userId: string | undefined,
    realtimeService: RealtimeFacade | undefined,
    executeFn: (
      signal: AbortSignal,
      onLogChunk: (chunk: string) => void,
    ) => Promise<T>,
    options?: CompileLockOptions,
  ): Promise<T> {
    const priority: CompilePriority = options?.priority ?? 'manual';
    const compileKey = getCompileName(spaceId, userId);

    // 1. Per-(spaceId, userId) lock check (Overleaf `services/clsi/app/js/CompileManager.js:51-76` &
    // `services/clsi/app/js/LockManager.js:21-30` & `CompileController.js:77-80, 234-246`):
    const currentLock = this.locks.get(compileKey);
    if (currentLock != null) {
      if (currentLock.isExpired()) {
        this.logger.warn(`Compile lock expired for "${compileKey}"`);
        currentLock.abortController.abort();
        this.locks.delete(compileKey);
      } else if (options?.forceClean) {
        this.logger.log(
          `Stopping active compile for "${compileKey}" before forceClean (Overleaf clearCache parity)`,
        );
        currentLock.abortController.abort();
        await this.waitSettled(
          currentLock.waitForRelease(),
          this.supersedeGraceMs,
        );
      } else {
        throw this.toHttpException(
          new AlreadyCompilingError('compile in progress'),
          spaceId,
        );
      }
    }

    // 2. Auto-compile backoff under load (Overleaf `services/web/app/src/Features/Compile/CompileManager.mjs:40-49, 286-317`):
    this.pruneExpiredLocks();
    const activeCount = this.locks.size;
    if (priority === 'auto' && activeCount >= this.autoShedThreshold) {
      throw this.toHttpException(
        new AutoCompileShedError(activeCount, this.autoShedThreshold),
        spaceId,
      );
    }

    // 3. Fail-fast server concurrency & live memory cap (Overleaf `services/clsi/app/js/LockManager.js:32, 39-51`):
    this.checkConcurrencyLimit(spaceId);

    // 4. Per-(spaceId, userId) rate limit check (Overleaf `CompileManager.mjs:280-284` `compile:${spaceId}:${userId}`)
    this.checkRateLimit(compileKey);

    const now = Date.now();
    const abortController = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    const expiresAt = now + this.lockTimeoutMs;

    const session: InFlightCompileSession = {
      compileKey,
      spaceId,
      userId,
      priority,
      abortController,
      startedAt: now,
      expiresAt,
      settled,
      isExpired: () => Date.now() >= expiresAt,
      waitForRelease: () => settled,
    };
    this.locks.set(compileKey, session);

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
      realtimeService?.broadcastCompileProgress(spaceId, {
        status: 'compiling',
        logs: [payload],
      });
    };

    try {
      if (abortController.signal.aborted) {
        throw this.toHttpException(new CompileAbortedError(), spaceId);
      }

      const onLogChunk = (chunk: string) => {
        if (abortController.signal.aborted || !chunk) return;
        const combined = pendingLogBuffer + chunk;
        pendingLogBuffer =
          combined.length > this.maxLogChunkBytes
            ? combined.slice(combined.length - this.maxLogChunkBytes)
            : combined;
        if (!flushTimer) {
          flushTimer = setTimeout(flushLogChunks, this.logChunkFlushIntervalMs);
          flushTimer.unref?.();
        }
      };

      realtimeService?.broadcastCompileProgress(spaceId, {
        status: 'compiling',
        logs: ['[CLSI] Compilation started...'],
      });

      return await executeFn(abortController.signal, onLogChunk);
    } finally {
      clearFlushTimer();
      if (this.locks.get(compileKey) === session) {
        this.locks.delete(compileKey);
      }
      markSettled();
    }
  }

  /**
   * Citation: Overleaf `services/clsi/app/js/CompileManager.js` (`stopCompile`, lines 415-428)
   * & `services/web/app/src/Features/Compile/CompileController.mjs` (lines 598-604).
   * Explicitly kills the active compilation process for `(spaceId, userId)`.
   * Because the lock key is `${spaceId}-${userId}`, User B calling stopCompile cannot
   * kill User A's active compilation.
   */
  public cancel(spaceId: string, userId?: string): boolean {
    const compileKey = getCompileName(spaceId, userId);
    const session = this.locks.get(compileKey);
    if (session) {
      session.abortController.abort();
      this.locks.delete(compileKey);
      this.logger.log(`Manually cancelled compilation for "${compileKey}"`);
      return true;
    }
    return false;
  }

  public isInFlight(spaceId: string, userId?: string): boolean {
    const lock = this.locks.get(getCompileName(spaceId, userId));
    return Boolean(lock && !lock.isExpired());
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

  private toHttpException(err: unknown, spaceId: string): Error {
    if (err instanceof AlreadyCompilingError) {
      // Citation: Overleaf `services/clsi/app/js/CompileController.js` (lines 77-80):
      // `if (error instanceof Errors.AlreadyCompilingError) { code = 423; status = 'compile-in-progress'; }`
      return new HttpException(
        {
          code: err.code,
          status: err.status,
          message: err.message,
        },
        423,
      );
    }
    if (err instanceof TooManyCompileRequestsError) {
      // Citation: Overleaf `services/clsi/app/js/CompileController.js` (lines 97-101):
      // `error instanceof Errors.TooManyCompileRequestsError -> code = 503; status = 'unavailable'`
      this.logger.warn(
        `[Backpressure] Exceeded compiler concurrency limit (${this.compileConcurrencyLimit}) – rejecting project "${spaceId}"`,
      );
      return new HttpException(
        {
          code: err.code,
          status: err.status,
          message: err.message,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (
      err instanceof CompileAbortedError ||
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
          status: err.status,
          message: err.message,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private checkRateLimit(compileKey: string): void {
    const now = Date.now();
    let timestamps = this.compileTimestamps.get(compileKey);
    if (!timestamps) {
      timestamps = [];
      this.compileTimestamps.set(compileKey, timestamps);
    }

    const windowStart = now - 60000;
    timestamps = timestamps.filter((t) => t > windowStart);
    this.compileTimestamps.set(compileKey, timestamps);

    if (this.compileTimestamps.size > 500) {
      this.pruneStaleTimestamps(windowStart);
    }

    if (timestamps.length >= this.maxPerMinute) {
      throw this.toHttpException(
        new CompileRateLimitExceededError(this.maxPerMinute),
        compileKey,
      );
    }

    const lastCompile = timestamps[timestamps.length - 1];
    if (lastCompile && now - lastCompile < this.minIntervalMs) {
      this.logger.debug(
        `[Debounce] "${compileKey}" requested compile within debounce window (${now - lastCompile}ms < ${this.minIntervalMs}ms).`,
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
