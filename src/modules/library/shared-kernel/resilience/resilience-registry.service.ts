import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreaker, CircuitBreakerOptions } from './circuit-breaker';
import { TokenBucketRateLimiter, RateLimiterOptions } from './rate-limiter';

export interface ResilienceExecuteOptions<T> {
  fallback?: (err: Error) => Promise<T>;
  signal?: AbortSignal;
  tokens?: number;
}

/**
 * Central Resilience Registry Service.
 *
 * Manages Circuit Breakers and Rate Limiters for all Academic External APIs and internal sidecars.
 * Preconfigured with standard SLAs to protect backend throughput and avoid third-party IP bans.
 */
@Injectable()
export class ResilienceRegistryService {
  private readonly logger = new Logger(ResilienceRegistryService.name);

  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly limiters = new Map<string, TokenBucketRateLimiter>();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Retrieves or initializes a Circuit Breaker for the given provider name.
   */
  public getCircuitBreaker(
    name: string,
    options?: CircuitBreakerOptions,
  ): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ name, ...options });
      this.breakers.set(name, breaker);
      this.logger.log(`Initialized CircuitBreaker for "${name}"`);
    }
    return breaker;
  }

  /**
   * Retrieves or initializes a Rate Limiter for the given provider name.
   */
  public getRateLimiter(
    name: string,
    options?: RateLimiterOptions,
  ): TokenBucketRateLimiter {
    let limiter = this.limiters.get(name);
    if (!limiter) {
      limiter = new TokenBucketRateLimiter({
        name,
        capacity: options?.capacity ?? 10,
        refillRatePerSec: options?.refillRatePerSec ?? 5,
      });
      this.limiters.set(name, limiter);
      this.logger.log(`Initialized RateLimiter for "${name}"`);
    }
    return limiter;
  }

  /**
   * Executes an asynchronous task protected by both Rate Limiter and Circuit Breaker.
   */
  public async execute<T>(
    name: string,
    fn: () => Promise<T>,
    options?: ResilienceExecuteOptions<T>,
  ): Promise<T> {
    const limiter = this.getRateLimiter(name);
    const breaker = this.getCircuitBreaker(name);

    // 1. Enforce rate limit (waits if rate limit reached, abortable)
    await limiter.acquire(options?.tokens ?? 1, options?.signal);

    // 2. Execute via circuit breaker (fast-fails if circuit is OPEN)
    return breaker.execute(fn, options?.fallback);
  }

  /**
   * Resets all circuit breakers and rate limiters (primarily for unit tests).
   */
  public resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
    for (const limiter of this.limiters.values()) {
      limiter.reset();
    }
  }

  private registerDefaults(): void {
    // 1. DOI.org Content Negotiation: max 5 req/s, breaker threshold 4
    this.breakers.set(
      'doi-org',
      new CircuitBreaker({
        name: 'doi-org',
        failureThreshold: 4,
        resetTimeoutMs: 20000,
      }),
    );
    this.limiters.set(
      'doi-org',
      new TokenBucketRateLimiter({
        name: 'doi-org',
        capacity: 5,
        refillRatePerSec: 5,
      }),
    );

    // 2. arXiv API: STRICT rule - 1 request per 3 seconds (0.33 req/s)
    this.breakers.set(
      'arxiv',
      new CircuitBreaker({
        name: 'arxiv',
        failureThreshold: 3,
        resetTimeoutMs: 60000,
      }),
    );
    this.limiters.set(
      'arxiv',
      new TokenBucketRateLimiter({
        name: 'arxiv',
        capacity: 1,
        refillRatePerSec: 0.33,
      }),
    );

    // 3. CrossRef API: max 10 req/s
    this.breakers.set(
      'crossref',
      new CircuitBreaker({
        name: 'crossref',
        failureThreshold: 5,
        resetTimeoutMs: 30000,
      }),
    );
    this.limiters.set(
      'crossref',
      new TokenBucketRateLimiter({
        name: 'crossref',
        capacity: 10,
        refillRatePerSec: 10,
      }),
    );

    // 4. PubMed / NCBI API: max 3 req/s
    this.breakers.set(
      'pubmed',
      new CircuitBreaker({
        name: 'pubmed',
        failureThreshold: 4,
        resetTimeoutMs: 30000,
      }),
    );
    this.limiters.set(
      'pubmed',
      new TokenBucketRateLimiter({
        name: 'pubmed',
        capacity: 3,
        refillRatePerSec: 3,
      }),
    );

    // 5. GROBID ML Sidecar: local container, max 4 concurrent requests
    this.breakers.set(
      'grobid',
      new CircuitBreaker({
        name: 'grobid',
        failureThreshold: 3,
        resetTimeoutMs: 15000,
      }),
    );
    this.limiters.set(
      'grobid',
      new TokenBucketRateLimiter({
        name: 'grobid',
        capacity: 4,
        refillRatePerSec: 4,
      }),
    );
  }
}
