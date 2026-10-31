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

  private static readonly MAX_DYNAMIC_HOSTS = 500;
  private static readonly IDLE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly PINNED_PROVIDERS = new Set<string>([
    'doi-org',
    'arxiv',
    'crossref',
    'pubmed',
    'openalex',
    'semantic-scholar',
    'unpaywall',
    'dblp',
    'openlibrary',
  ]);

  private static readonly HOST_TO_PROVIDER_MAP: Record<string, string> = {
    'export.arxiv.org': 'arxiv',
    'arxiv.org': 'arxiv',
    arxiv: 'arxiv',
    'api.crossref.org': 'crossref',
    crossref: 'crossref',
    'eutils.ncbi.nlm.nih.gov': 'pubmed',
    'api.ncbi.nlm.nih.gov': 'pubmed',
    'www.ebi.ac.uk': 'pubmed',
    pubmed: 'pubmed',
    'api.semanticscholar.org': 'semantic-scholar',
    semanticscholar: 'semantic-scholar',
    'semantic-scholar': 'semantic-scholar',
    'api.openalex.org': 'openalex',
    openalex: 'openalex',
    'api.unpaywall.org': 'unpaywall',
    unpaywall: 'unpaywall',
    'dblp.org': 'dblp',
    'dblp.uni-trier.de': 'dblp',
    dblp: 'dblp',
    'openlibrary.org': 'openlibrary',
    openlibrary: 'openlibrary',
    'doi.org': 'doi-org',
    'dx.doi.org': 'doi-org',
    'doi-org': 'doi-org',
  };

  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly limiters = new Map<string, TokenBucketRateLimiter>();
  private readonly dynamicHostLastUsed = new Map<string, number>();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Normalizes provider names and known academic hostnames to canonical registry keys.
   */
  public normalizeKey(key: string): string {
    const trimmed = (key || '').trim();
    if (trimmed.toLowerCase().startsWith('feed:')) {
      return `feed:${trimmed.slice(5).trim()}`;
    }
    const cleaned = trimmed
      .toLowerCase()
      .replace(/^(https?:\/\/)/i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .replace(/\.+$/, '');
    return ResilienceRegistryService.HOST_TO_PROVIDER_MAP[cleaned] ?? cleaned;
  }

  public getBreakersByPrefix(prefix: string): Map<string, CircuitBreaker> {
    const normalizedPrefix = prefix.toLowerCase();
    const buildSnapshot = (): Map<string, CircuitBreaker> => {
      const out = new Map<string, CircuitBreaker>();
      for (const [k, v] of this.breakers.entries()) {
        if (k.toLowerCase().startsWith(normalizedPrefix)) {
          out.set(k.slice(prefix.length), v);
        }
      }
      return out;
    };
    return new Proxy(new Map<string, CircuitBreaker>(), {
      get: (_target, prop) => {
        const snapshot = buildSnapshot();
        if (prop === 'size') return snapshot.size;
        if (prop === 'get') return (key: string) => this.breakers.get(this.normalizeKey(`${prefix}${key}`));
        if (prop === 'has') return (key: string) => this.breakers.has(this.normalizeKey(`${prefix}${key}`));
        const val = Reflect.get(snapshot, prop, snapshot);
        return typeof val === 'function' ? val.bind(snapshot) : val;
      },
    });
  }

  private touchDynamicHost(name: string): void {
    if (ResilienceRegistryService.PINNED_PROVIDERS.has(name)) {
      return;
    }
    const now = Date.now();
    // Refresh insertion order for LRU behavior
    if (this.dynamicHostLastUsed.has(name)) {
      this.dynamicHostLastUsed.delete(name);
    }
    this.dynamicHostLastUsed.set(name, now);

    if (
      this.dynamicHostLastUsed.size >
      ResilienceRegistryService.MAX_DYNAMIC_HOSTS
    ) {
      this.evictStaleOrOldestDynamicHosts(now);
    }
  }

  private evictStaleOrOldestDynamicHosts(now: number): void {
    // 1. Evict any expired entries older than 1-hour idle TTL
    for (const [host, lastUsed] of this.dynamicHostLastUsed.entries()) {
      if (now - lastUsed > ResilienceRegistryService.IDLE_TTL_MS) {
        this.dynamicHostLastUsed.delete(host);
        this.breakers.delete(host);
        this.limiters.delete(host);
      } else {
        // Since Map is ordered by last-used timestamp ascending, we can stop scanning for TTL once we hit a fresh entry
        break;
      }
    }

    // 2. If still exceeding MAX_DYNAMIC_HOSTS, evict oldest LRU entries
    while (
      this.dynamicHostLastUsed.size >
      ResilienceRegistryService.MAX_DYNAMIC_HOSTS
    ) {
      const oldestKey = this.dynamicHostLastUsed.keys().next().value;
      if (!oldestKey) break;
      this.dynamicHostLastUsed.delete(oldestKey);
      this.breakers.delete(oldestKey);
      this.limiters.delete(oldestKey);
    }
  }

  /**
   * Retrieves or initializes a Circuit Breaker for the given provider name.
   */
  public getCircuitBreaker(
    rawName: string,
    options?: CircuitBreakerOptions,
  ): CircuitBreaker {
    const name = this.normalizeKey(rawName);
    const now = Date.now();
    const lastUsed = this.dynamicHostLastUsed.get(name);
    if (
      lastUsed !== undefined &&
      now - lastUsed > ResilienceRegistryService.IDLE_TTL_MS &&
      !ResilienceRegistryService.PINNED_PROVIDERS.has(name)
    ) {
      this.dynamicHostLastUsed.delete(name);
      this.breakers.delete(name);
      this.limiters.delete(name);
    }

    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker({ name, ...options });
      this.breakers.set(name, breaker);
      this.logger.log(`Initialized CircuitBreaker for "${name}"`);
    }
    this.touchDynamicHost(name);
    return breaker;
  }

  /**
   * Retrieves or initializes a Rate Limiter for the given provider name.
   */
  public getRateLimiter(
    rawName: string,
    options?: RateLimiterOptions,
  ): TokenBucketRateLimiter {
    const name = this.normalizeKey(rawName);
    const now = Date.now();
    const lastUsed = this.dynamicHostLastUsed.get(name);
    if (
      lastUsed !== undefined &&
      now - lastUsed > ResilienceRegistryService.IDLE_TTL_MS &&
      !ResilienceRegistryService.PINNED_PROVIDERS.has(name)
    ) {
      this.dynamicHostLastUsed.delete(name);
      this.breakers.delete(name);
      this.limiters.delete(name);
    }

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
    this.touchDynamicHost(name);
    return limiter;
  }

  /**
   * Diagnostic observability: exports real-time status of all circuit breakers.
   */
  public getAllBreakerStatuses(): Record<
    string,
    { state: string; failureCount: number; canExecute: boolean }
  > {
    const statuses: Record<
      string,
      { state: string; failureCount: number; canExecute: boolean }
    > = {};
    for (const [name, breaker] of this.breakers.entries()) {
      statuses[name] = {
        state: breaker.getState(),
        failureCount: breaker.getFailures(),
        canExecute: breaker.peekCanExecute(),
      };
    }
    return statuses;
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
    for (const host of this.dynamicHostLastUsed.keys()) {
      this.breakers.delete(host);
      this.limiters.delete(host);
    }
    this.dynamicHostLastUsed.clear();
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

    // 5. Additional Pinned Academic Providers (OpenAlex, Semantic Scholar, Unpaywall, DBLP, OpenLibrary)
    const additionalPinned: Array<{
      name: string;
      capacity: number;
      refillRatePerSec: number;
      failureThreshold: number;
      resetTimeoutMs: number;
    }> = [
      {
        name: 'openalex',
        capacity: 10,
        refillRatePerSec: 10,
        failureThreshold: 5,
        resetTimeoutMs: 30000,
      },
      {
        name: 'semantic-scholar',
        capacity: 5,
        refillRatePerSec: 5,
        failureThreshold: 4,
        resetTimeoutMs: 30000,
      },
      {
        name: 'unpaywall',
        capacity: 10,
        refillRatePerSec: 10,
        failureThreshold: 5,
        resetTimeoutMs: 30000,
      },
      {
        name: 'dblp',
        capacity: 5,
        refillRatePerSec: 5,
        failureThreshold: 4,
        resetTimeoutMs: 30000,
      },
      {
        name: 'openlibrary',
        capacity: 5,
        refillRatePerSec: 5,
        failureThreshold: 4,
        resetTimeoutMs: 30000,
      },
    ];

    for (const p of additionalPinned) {
      this.breakers.set(
        p.name,
        new CircuitBreaker({
          name: p.name,
          failureThreshold: p.failureThreshold,
          resetTimeoutMs: p.resetTimeoutMs,
        }),
      );
      this.limiters.set(
        p.name,
        new TokenBucketRateLimiter({
          name: p.name,
          capacity: p.capacity,
          refillRatePerSec: p.refillRatePerSec,
        }),
      );
    }
  }
}
