import { Logger } from '@nestjs/common';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  name?: string;
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMaxAttempts?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly resetTimeoutMs: number,
  ) {
    super(
      `Circuit breaker for "${breakerName}" is OPEN. Requests are temporarily short-circuited.`,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Enterprise Resilient Circuit Breaker.
 *
 * Protects downstream systems and the host application against cascading failures:
 * - CLOSED: Normal operation. All requests pass through.
 * - OPEN: Outage detected. Fast-fails immediately (0ms) without issuing network requests.
 * - HALF_OPEN: Cooldown expired. Allows a controlled probe request to check if the remote service has recovered.
 */
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private failureSequence = 0;
  private lastFailureTime = 0;
  private lastStateChangeTime = 0;
  private halfOpenAttempts = 0;

  public readonly name: string;
  public readonly failureThreshold: number;
  public readonly resetTimeoutMs: number;
  public readonly halfOpenMaxAttempts: number;
  private readonly onStateChange?: (
    from: CircuitState,
    to: CircuitState,
  ) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitState {
    const now = Date.now();
    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transitionTo('HALF_OPEN');
        this.halfOpenAttempts = 0;
      }
    } else if (this.state === 'HALF_OPEN') {
      if (
        this.lastStateChangeTime > 0 &&
        now - this.lastStateChangeTime >= this.resetTimeoutMs
      ) {
        this.halfOpenAttempts = 0;
        this.lastStateChangeTime = now;
      }
    }
    return this.state;
  }

  public releaseHalfOpenProbe(): void {
    if (this.state === 'HALF_OPEN' && this.halfOpenAttempts > 0) {
      this.halfOpenAttempts--;
    }
  }

  public getFailures(): number {
    return this.consecutiveFailures;
  }

  public get failures(): number {
    return this.consecutiveFailures;
  }

  public get isOpen(): boolean {
    return this.getState() === 'OPEN';
  }

  public getFailureSequence(): number {
    return this.failureSequence;
  }

  public canExecute(): boolean {
    const currentState = this.getState();

    if (currentState === 'CLOSED') {
      return true;
    }

    if (currentState === 'HALF_OPEN') {
      if (this.halfOpenAttempts < this.halfOpenMaxAttempts) {
        this.halfOpenAttempts++;
        return true;
      }
      return false;
    }

    // OPEN state: fast-fail
    return false;
  }

  /**
   * Side-effect-free inspection of whether a request can currently execute.
   * Unlike `canExecute()`, this does not consume a `halfOpenAttempts` probe slot.
   */
  public peekCanExecute(): boolean {
    const currentState = this.getState();

    if (currentState === 'CLOSED') {
      return true;
    }

    if (currentState === 'HALF_OPEN') {
      return this.halfOpenAttempts < this.halfOpenMaxAttempts;
    }

    return false;
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.logger.log(
        `[CircuitBreaker:${this.name}] Probe request succeeded. Closing circuit (Service recovered).`,
      );
      this.transitionTo('CLOSED');
    }
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
  }

  public recordFailure(isOutage = true): void {
    if (!isOutage) return;

    this.consecutiveFailures++;
    this.failureSequence++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.logger.warn(
        `[CircuitBreaker:${this.name}] Probe request failed in HALF_OPEN. Re-opening circuit for ${this.resetTimeoutMs}ms.`,
      );
      this.transitionTo('OPEN');
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.logger.error(
        `[CircuitBreaker:${this.name}] Failure threshold reached (${this.consecutiveFailures}/${this.failureThreshold}). Circuit OPENED for ${this.resetTimeoutMs}ms.`,
      );
      this.transitionTo('OPEN');
    }
  }

  public async execute<T>(
    fn: () => Promise<T>,
    fallback?: (err: Error) => Promise<T>,
  ): Promise<T> {
    if (!this.canExecute()) {
      const openErr = new CircuitBreakerOpenError(
        this.name,
        this.resetTimeoutMs,
      );
      if (fallback) {
        return fallback(openErr);
      }
      throw openErr;
    }

    const failureSeqBefore = this.failureSequence;
    try {
      const result = await fn();
      if (this.failureSequence === failureSeqBefore) {
        this.recordSuccess();
      }
      return result;
    } catch (err: unknown) {
      const status =
        (err as { status?: number; statusCode?: number } | null)?.status ??
        (err as { status?: number; statusCode?: number } | null)?.statusCode;
      const errMessage = err instanceof Error ? err.message : String(err ?? '');
      const isClientError =
        status === 400 ||
        status === 404 ||
        /\bHTTP\s+(?:400|404)\b/i.test(errMessage) ||
        /\bstatus(?:\s+code)?\s*(?:=|:)?\s*(?:400|404)\b/i.test(errMessage);
      if (isClientError) {
        this.releaseHalfOpenProbe();
      } else {
        this.recordFailure(true);
      }
      if (fallback) {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        return fallback(errorObj);
      }
      throw err;
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.lastStateChangeTime = 0;
    this.halfOpenAttempts = 0;
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeTime = Date.now();
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch {
        // Safe callback execution
      }
    }
  }
}

export interface IRateLimitRedisClient {
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

export interface IRateLimitStore {
  isReady?: () => boolean;
  getClient?: () => IRateLimitRedisClient | null;
}

export interface RateLimiterOptions {
  name?: string;
  capacity: number;
  refillRatePerSec: number;
  redis?: IRateLimitStore;
}

/**
 * Enterprise Token Bucket Rate Limiter.
 *
 * Enforces polite rate limits for academic external APIs (e.g. arXiv 1 req/3s, CrossRef 10 req/s, PubMed 3 req/s).
 * - Multi-Pod Atomic Coordination: Employs Redis Lua script for distributed token reservation with virtual deficit queues.
 * - Single-Process Fallback: Operates seamlessly in-memory when Redis is unconfigured, unreachable, or in unit tests.
 * - Staggered Queueing: Distributes concurrent bursts with deterministic millisecond spacing instead of thundering herd stampedes.
 */
export class TokenBucketRateLimiter {
  private readonly logger = new Logger(TokenBucketRateLimiter.name);
  public readonly name: string;
  public readonly capacity: number;
  public readonly refillRatePerSec: number;
  private readonly redisStore?: IRateLimitStore;

  private tokens: number;
  private lastRefillTimestamp: number;

  private static readonly ACQUIRE_LUA_SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    local data = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(data[1])
    local last_refill = tonumber(data[2])

    if not tokens or not last_refill then
      tokens = capacity
      last_refill = now
    else
      local elapsed_sec = math.max(0, (now - last_refill) / 1000)
      tokens = math.min(capacity, tokens + (elapsed_sec * refill_rate))
      last_refill = now
    end

    local wait_ms = 0
    if tokens >= requested then
      tokens = tokens - requested
    else
      tokens = tokens - requested
      local deficit = -tokens
      wait_ms = math.max(10, math.ceil((deficit / refill_rate) * 1000))
    end

    redis.call('HMSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
    local ttl = math.max(3600, math.ceil(capacity / refill_rate) * 2)
    redis.call('EXPIRE', key, ttl)

    return { wait_ms, tostring(tokens) }
  `;

  private static readonly REFUND_LUA_SCRIPT = `
    local key = KEYS[1]
    local count = tonumber(ARGV[1])
    local capacity = tonumber(ARGV[2])

    local data = redis.call('HGET', key, 'tokens')
    local tokens = tonumber(data)
    if tokens then
      tokens = math.min(capacity, tokens + count)
      redis.call('HSET', key, 'tokens', tostring(tokens))
    end
    return tostring(tokens or capacity)
  `;

  private static readonly RESET_LUA_SCRIPT = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])
    redis.call('HMSET', key, 'tokens', tostring(capacity), 'last_refill', tostring(now))
    return 1
  `;

  constructor(options: RateLimiterOptions) {
    this.name = options.name || 'default';
    this.capacity = Math.max(1, options.capacity);
    this.refillRatePerSec = Math.max(0.001, options.refillRatePerSec);
    this.redisStore = options.redis;
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  private getRedisClient(): IRateLimitRedisClient | null {
    if (this.redisStore && typeof this.redisStore.isReady === 'function') {
      if (!this.redisStore.isReady()) return null;
    }
    return this.redisStore?.getClient?.() ?? null;
  }

  /**
   * Synchronous non-blocking token check (local memory cache).
   * Returns true if tokens were acquired, false otherwise.
   */
  public tryAcquire(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Acquires `count` tokens, waiting asynchronously if tokens are exhausted.
   * Multi-pod aware: atomically reserves virtual token deficit in Redis so concurrent callers queue fairly.
   * Falls back to in-memory virtual queue if Redis is unconfigured or unreachable.
   */
  public async acquire(count = 1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw (
        signal.reason || new Error('Aborted before acquiring rate limit token')
      );
    }

    const client = this.getRedisClient();
    if (client) {
      try {
        const redisKey = `flux:ratelimit:${this.name}`;
        const res = (await client.eval(
          TokenBucketRateLimiter.ACQUIRE_LUA_SCRIPT,
          1,
          redisKey,
          this.capacity,
          this.refillRatePerSec,
          Date.now(),
          count,
        )) as [number, string];

        const waitMs = Number(res[0]);

        if (waitMs <= 0) {
          return;
        }

        this.logger.debug(
          `[RateLimiter:${this.name}] Distributed rate limit reached. Waiting ${waitMs}ms for ${count} token(s).`,
        );

        await new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout | null = null;

          const onAbort = () => {
            if (timer) clearTimeout(timer);
            // Cooperative refund in Redis
            void client
              .eval(
                TokenBucketRateLimiter.REFUND_LUA_SCRIPT,
                1,
                redisKey,
                count,
                this.capacity,
              )
              .catch(() => {});

            const reason =
              signal?.reason instanceof Error
                ? signal.reason
                : new Error(
                    signal?.reason
                      ? String(signal.reason)
                      : `Aborted while waiting for rate limit token on "${this.name}"`,
                  );
            reject(reason);
          };

          if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
          }

          timer = setTimeout(() => {
            if (signal) {
              signal.removeEventListener('abort', onAbort);
            }
            resolve();
          }, waitMs);
        });

        return;
      } catch (err: unknown) {
        if (signal?.aborted) {
          throw (
            signal.reason ||
            new Error('Aborted while waiting for rate limit token')
          );
        }
        this.logger.warn(
          `[RateLimiter:${this.name}] Redis distributed acquire failed: ${err instanceof Error ? err.message : String(err)}. Falling back to in-memory limiter.`,
        );
      }
    }

    // In-memory fallback
    if (this.tryAcquire(count)) {
      return;
    }

    // Reserve tokens up-front (allowing this.tokens to go negative as virtual debt)
    // so concurrent callers calculate staggered wait times rather than waking up simultaneously.
    this.refill();
    this.tokens -= count;
    const deficit = Math.max(0, -this.tokens);
    const waitMs = Math.max(
      10,
      Math.ceil((deficit / this.refillRatePerSec) * 1000),
    );

    this.logger.debug(
      `[RateLimiter:${this.name}] Rate limit reached. Waiting ${waitMs}ms for ${count} token(s).`,
    );

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const onAbort = () => {
        if (timer) clearTimeout(timer);
        // Refund the reserved tokens on abort
        this.refill();
        this.tokens = Math.min(this.capacity, this.tokens + count);
        const reason =
          signal?.reason instanceof Error
            ? signal.reason
            : new Error(
                signal?.reason
                  ? String(signal.reason)
                  : `Aborted while waiting for rate limit token on "${this.name}"`,
              );
        reject(reason);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        this.refill();
        resolve();
      }, waitMs);
    });
  }

  public reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
    const client = this.getRedisClient();
    if (client) {
      client
        .eval(
          TokenBucketRateLimiter.RESET_LUA_SCRIPT,
          1,
          `flux:ratelimit:${this.name}`,
          this.capacity,
          Date.now(),
        )
        .catch(() => {});
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillTimestamp) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillRatePerSec,
      );
      this.lastRefillTimestamp = now;
    }
  }
}

/**
 * SingleFlightCoalescer — In-Process Request Coalescing / Stampede Protection.
 *
 * Ensures that when multiple concurrent callers request the same key at the exact same millisecond
 * (e.g., 500 project collaborators polling `/library/sync/version` or reloading `/library/bootstrap`),
 * only ONE underlying async factory executes while all concurrent callers await the shared Promise.
 * Once the Promise settles (resolves or rejects), the in-flight entry is immediately evicted so
 * subsequent callers observe fresh state or L1/L2 cache.
 */
export class SingleFlightCoalescer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Executes `factory` for `key` if no request for `key` is currently in flight,
   * or joins the existing in-flight Promise.
   */
  public execute<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      try {
        return await factory();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Returns the current number of active in-flight keys (useful for observability and testing).
   */
  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Clears all tracked in-flight entries.
   */
  public clear(): void {
    this.inFlight.clear();
  }
}

/**
 * Deterministic Lock Ordering Helper (Coffman Deadlock Prevention — Condition #4: Circular Wait).
 *
 * Returns a deduplicated, lexicographically sorted copy of resource IDs (`string[]`)
 * so concurrent transactions acquiring row/index locks on multiple entities always
 * lock in strictly ascending canonical order, eliminating circular-wait deadlocks (`40P01`).
 */
export function sortLockKeys(ids: readonly string[]): string[] {
  if (!ids || ids.length === 0) return [];
  const unique = Array.from(
    new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  );
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface BulkheadSemaphoreOptions {
  name?: string;
  maxConcurrent: number;
  maxQueueSize?: number;
}

/**
 * Counting Semaphore / Bulkhead Admission Controller (OS Memory Thrashing & Resource Isolation).
 *
 * Caps the number of concurrent heavy background operations (e.g., full-library duplicate scans,
 * quality audits, retraction batch scans, or vector backfills) so background tasks never starve
 * interactive user queries in the shared PostgreSQL connection pool (`pg.Pool`).
 */
export class BulkheadSemaphore {
  public readonly name: string;
  public readonly maxConcurrent: number;
  public readonly maxQueueSize: number;

  private activeCount = 0;
  private readonly waitQueue: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(options: BulkheadSemaphoreOptions) {
    this.name = options.name || 'default-bulkhead';
    this.maxConcurrent = Math.max(1, options.maxConcurrent);
    this.maxQueueSize = Math.max(0, options.maxQueueSize ?? 200);
  }

  public get active(): number {
    return this.activeCount;
  }

  public get queued(): number {
    return this.waitQueue.length;
  }

  public acquire(): Promise<() => void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      return Promise.resolve(this.createReleaseFn());
    }

    if (this.waitQueue.length >= this.maxQueueSize) {
      return Promise.reject(
        new Error(
          `BulkheadSemaphore "${this.name}" wait queue is full (${this.maxQueueSize})`,
        ),
      );
    }

    return new Promise<() => void>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  public async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private createReleaseFn(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waitQueue.shift();
      if (next) {
        next.resolve(this.createReleaseFn());
      } else {
        this.activeCount = Math.max(0, this.activeCount - 1);
      }
    };
  }
}

