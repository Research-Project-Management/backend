import { Logger } from '@nestjs/common';

export interface RateLimiterOptions {
  name?: string;
  capacity: number;
  refillRatePerSec: number;
}

/**
 * Token Bucket Rate Limiter.
 *
 * Enforces polite rate limits for academic external APIs (e.g. arXiv 1 req/3s, CrossRef 10 req/s, PubMed 3 req/s).
 * Supports bursts up to `capacity` while smoothly replenishing tokens at `refillRatePerSec`.
 */
export class TokenBucketRateLimiter {
  private readonly logger = new Logger(TokenBucketRateLimiter.name);
  public readonly name: string;
  public readonly capacity: number;
  public readonly refillRatePerSec: number;

  private tokens: number;
  private lastRefillTimestamp: number;

  constructor(options: RateLimiterOptions) {
    this.name = options.name || 'default';
    this.capacity = Math.max(1, options.capacity);
    this.refillRatePerSec = Math.max(0.001, options.refillRatePerSec);
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Returns current available tokens after continuous replenishment.
   */
  public getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Attempts to acquire `count` tokens non-blockingly.
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
   * Can be cancelled cooperatively via `signal`.
   */
  public async acquire(count = 1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Aborted before acquiring rate limit token');
    }

    if (this.tryAcquire(count)) {
      return;
    }

    // Calculate wait time needed for required tokens
    const missing = count - this.tokens;
    const waitMs = Math.max(10, Math.ceil((missing / this.refillRatePerSec) * 1000));

    this.logger.debug(
      `[RateLimiter:${this.name}] Rate limit reached. Waiting ${waitMs}ms for ${count} token(s).`,
    );

    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(
          signal?.reason ||
            new Error(
              `Aborted while waiting for rate limit token on "${this.name}"`,
            ),
        );
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        this.refill();
        this.tokens = Math.max(0, this.tokens - count);
        resolve();
      }, waitMs);
    });
  }

  public reset(): void {
    this.tokens = this.capacity;
    this.lastRefillTimestamp = Date.now();
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
