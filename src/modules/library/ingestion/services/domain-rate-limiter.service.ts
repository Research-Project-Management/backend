import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisCacheService } from '@/core';

export interface DomainRateLimitConfig {
  minIntervalMs: number;
}

/**
 * Domain-Specific Continuous-Time GCRA (Generic Cell Rate Algorithm) Rate Limiter.
 *
 * Guarantees minimum spacing between consecutive outgoing requests to external
 * academic APIs using Theoretical Arrival Time (TAT):
 *   t_next = max(t_now, t_last + minIntervalMs)
 *   waitMs = t_next - t_now
 */
@Injectable()
export class DomainRateLimiterService {
  private readonly logger = new Logger(DomainRateLimiterService.name);

  private static readonly MAX_DOMAINS = 1000;
  private readonly lastExecutionMap = new Map<string, number>();

  private bypassDelayEnabled = false;

  constructor(
    @Optional() private readonly redis?: RedisCacheService,
    @Optional() options?: { bypassDelay?: boolean },
  ) {
    if (options?.bypassDelay !== undefined) {
      this.bypassDelayEnabled = Boolean(options.bypassDelay);
    }
  }

  public setBypassDelay(bypass: boolean): void {
    this.bypassDelayEnabled = Boolean(bypass);
  }

  public get bypassDelay(): boolean {
    return this.bypassDelayEnabled;
  }

  public set bypassDelay(bypass: boolean) {
    this.bypassDelayEnabled = Boolean(bypass);
  }

  private readonly domainConfigs: Record<string, DomainRateLimitConfig> = {
    // arXiv: strict 1 request per 3 seconds guideline
    'export.arxiv.org': { minIntervalMs: 3000 },
    'arxiv.org': { minIntervalMs: 3000 },
    arxiv: { minIntervalMs: 3000 },

    // PubMed / NCBI E-utilities: ~3 requests per second without API key
    'eutils.ncbi.nlm.nih.gov': { minIntervalMs: 350 },
    'api.ncbi.nlm.nih.gov': { minIntervalMs: 350 },
    pubmed: { minIntervalMs: 350 },

    // DBLP Computer Science Bibliography: ~4-5 requests per second
    'dblp.org': { minIntervalMs: 250 },
    'dblp.uni-trier.de': { minIntervalMs: 250 },
    dblp: { minIntervalMs: 250 },

    // Semantic Scholar API: ~5 requests per second
    'api.semanticscholar.org': { minIntervalMs: 200 },
    semanticscholar: { minIntervalMs: 200 },
    'semantic-scholar': { minIntervalMs: 200 },

    // CrossRef Polite Pool: 50 requests per second
    'api.crossref.org': { minIntervalMs: 50 },
    crossref: { minIntervalMs: 50 },

    // OpenAlex: 50 requests per second
    'api.openalex.org': { minIntervalMs: 50 },
    openalex: { minIntervalMs: 50 },
  };

  /**
   * Normalizes hostname or provider key to canonical lookup key.
   */
  public normalizeKey(domainOrKey: string): string {
    return domainOrKey
      .toLowerCase()
      .replace(/^(https?:\/\/)/i, '')
      .replace(/:\d+$/, '')
      .trim();
  }

  /**
   * Resolves rate limit configuration for domain or provider identifier.
   */
  public getConfig(domainOrKey: string): DomainRateLimitConfig {
    const key = this.normalizeKey(domainOrKey);
    return this.domainConfigs[key] || { minIntervalMs: 50 };
  }

  private setLastExecution(key: string, timestamp: number): void {
    if (this.lastExecutionMap.has(key)) {
      this.lastExecutionMap.delete(key);
    } else if (
      this.lastExecutionMap.size >= DomainRateLimiterService.MAX_DOMAINS
    ) {
      const oldestKey = this.lastExecutionMap.keys().next().value;
      if (oldestKey !== undefined) {
        this.lastExecutionMap.delete(oldestKey);
      }
    }
    this.lastExecutionMap.set(key, timestamp);
  }

  /**
   * Enforces inter-request spacing for the target domain or provider via GCRA Theoretical Arrival Time (TAT).
   * Resolves when the caller is safe to proceed.
   */
  public async acquire(
    domainOrKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.bypassDelayEnabled) return;
    if (signal?.aborted) {
      await this.sleep(0, signal);
    }

    const normalizedDomain = this.normalizeKey(domainOrKey);
    const config = this.getConfig(normalizedDomain);
    const minIntervalMs = config.minIntervalMs;

    const now = Date.now();
    const lastExec = this.lastExecutionMap.get(normalizedDomain) ?? 0;
    const nextExec = Math.max(now, lastExec + minIntervalMs);
    let waitMs = nextExec - now;
    this.setLastExecution(normalizedDomain, nextExec);

    // Multi-Pod Distributed Check: Synchronize with cluster via atomic Redis Lua GCRA script
    if (this.redis?.isReady && this.redis.isReady()) {
      try {
        const client = this.redis.getClient?.();
        if (client) {
          const redisKey = `library:ratelimit:${normalizedDomain}:last_exec`;
          const ttlMs = Math.max(minIntervalMs * 3, 5000);
          const luaScript = `
            local last = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
            local now = tonumber(ARGV[1])
            local interval = tonumber(ARGV[2])
            local ttl = tonumber(ARGV[3])
            local next_exec = math.max(now, last + interval)
            redis.call('SET', KEYS[1], tostring(next_exec), 'PX', ttl)
            return next_exec - now
          `;
          if (typeof client.eval === 'function') {
            const evalRes = await client.eval(
              luaScript,
              1,
              redisKey,
              String(now),
              String(minIntervalMs),
              String(ttlMs),
            );
            const distWait = Math.max(0, Number(evalRes) || 0);
            if (distWait > waitMs) {
              waitMs = distWait;
              this.setLastExecution(normalizedDomain, now + waitMs);
            }
          } else {
            const redisLastExecStr = await client.get(redisKey);
            const redisLastExec = redisLastExecStr
              ? Number(redisLastExecStr)
              : 0;
            const distNextExec = Math.max(now, redisLastExec + minIntervalMs);
            const distWait = distNextExec - now;
            if (distWait > waitMs) {
              waitMs = distWait;
              this.setLastExecution(normalizedDomain, now + waitMs);
            }
            await client.set(
              redisKey,
              (now + waitMs).toString(),
              'PX',
              ttlMs,
            );
          }
        }
      } catch (redisErr) {
        // Non-blocking fallback to local TAT reservation
        this.logger.debug(
          `[DomainRateLimiter] Distributed rate-limit fallback: ${redisErr instanceof Error ? redisErr.message : String(redisErr)}`,
        );
      }
    }

    if (waitMs > 0) {
      this.logger.debug(
        `[DomainRateLimiter] Spacing request for "${normalizedDomain}" by ${waitMs}ms to comply with rate limits`,
      );
      await this.sleep(waitMs, signal);
    }
  }

  /**
   * Helper execution wrapper.
   */
  public async schedule<T>(
    domainOrKey: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.acquire(domainOrKey, signal);
    return task();
  }

  /**
   * Configures rate limit for a specific domain (useful for tests or custom endpoints).
   */
  public setDomainConfig(domain: string, config: DomainRateLimitConfig): void {
    const key = this.normalizeKey(domain);
    this.domainConfigs[key] = config;
  }

  /**
   * Resets rate limiter state (useful in test teardown).
   */
  public reset(): void {
    this.lastExecutionMap.clear();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const getAbortError = () =>
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(signal?.reason ? String(signal.reason) : 'Aborted');

      if (signal?.aborted) {
        return reject(getAbortError());
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(getAbortError());
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
