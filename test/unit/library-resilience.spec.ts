import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../src/modules/library/shared-kernel/resilience/circuit-breaker';
import { TokenBucketRateLimiter } from '../../src/modules/library/shared-kernel/resilience/rate-limiter';
import { ResilienceRegistryService } from '../../src/modules/library/shared-kernel/resilience/resilience-registry.service';
import { DoiContentNegotiationService } from '../../src/modules/library/citation/application/services/doi-content-negotiation.service';
import { GrobidClient } from '../../src/modules/library/shared-kernel/infra/grobid/grobid.client';

describe('Library Resilience Engine (Circuit Breaker & Token Bucket Rate Limiter)', () => {
  describe('CircuitBreaker', () => {
    let breaker: CircuitBreaker;

    beforeEach(() => {
      breaker = new CircuitBreaker({
        name: 'test-api',
        failureThreshold: 3,
        resetTimeoutMs: 200, // 200ms for fast testing
        halfOpenMaxAttempts: 1,
      });
    });

    it('should start in CLOSED state and successfully execute tasks', async () => {
      expect(breaker.getState()).toBe('CLOSED');

      const result = await breaker.execute(async () => 'hello-resilience');
      expect(result).toBe('hello-resilience');
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should trip to OPEN after failureThreshold is reached', async () => {
      const failingFn = async () => {
        throw new Error('Remote HTTP 503');
      };

      // 1st failure
      await expect(breaker.execute(failingFn)).rejects.toThrow('Remote HTTP 503');
      expect(breaker.getState()).toBe('CLOSED');

      // 2nd failure
      await expect(breaker.execute(failingFn)).rejects.toThrow('Remote HTTP 503');
      expect(breaker.getState()).toBe('CLOSED');

      // 3rd failure (hits failureThreshold = 3)
      await expect(breaker.execute(failingFn)).rejects.toThrow('Remote HTTP 503');
      expect(breaker.getState()).toBe('OPEN');

      // 4th call: Fast-fails immediately without running the fn
      const probeFn = jest.fn();
      await expect(breaker.execute(probeFn)).rejects.toThrow(
        CircuitBreakerOpenError,
      );
      expect(probeFn).not.toHaveBeenCalled();
    });

    it('should invoke fallback function when circuit is OPEN or on error', async () => {
      // Force OPEN
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');

      const fallback = jest.fn().mockResolvedValue('fallback-value');
      const action = jest.fn().mockResolvedValue('normal-value');

      const result = await breaker.execute(action, fallback);

      expect(result).toBe('fallback-value');
      expect(action).not.toHaveBeenCalled();
      expect(fallback).toHaveBeenCalledWith(expect.any(CircuitBreakerOpenError));
    });

    it('should transition to HALF_OPEN after resetTimeoutMs and recover to CLOSED on success', async () => {
      // Trip to OPEN
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe('OPEN');

      // Wait for resetTimeoutMs (200ms)
      await new Promise((resolve) => setTimeout(resolve, 220));

      expect(breaker.getState()).toBe('HALF_OPEN');

      // Probe request succeeds
      const probeResult = await breaker.execute(async () => 'probe-success');
      expect(probeResult).toBe('probe-success');

      // Circuit should now be closed!
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('should transition back to OPEN if probe request fails in HALF_OPEN', async () => {
      // Trip to OPEN
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      // Wait for resetTimeoutMs (200ms)
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Probe request fails
      await expect(
        breaker.execute(async () => {
          throw new Error('Probe still down');
        }),
      ).rejects.toThrow('Probe still down');

      // Should return to OPEN
      expect(breaker.getState()).toBe('OPEN');
    });
  });

  describe('TokenBucketRateLimiter', () => {
    it('should allow burst up to capacity and exhaust tokens', () => {
      const limiter = new TokenBucketRateLimiter({
        name: 'arxiv-test',
        capacity: 3,
        refillRatePerSec: 1,
      });

      expect(limiter.tryAcquire()).toBe(true); // 2 left
      expect(limiter.tryAcquire()).toBe(true); // 1 left
      expect(limiter.tryAcquire()).toBe(true); // 0 left
      expect(limiter.tryAcquire()).toBe(false); // exhausted
    });

    it('should replenish tokens over elapsed time', async () => {
      const limiter = new TokenBucketRateLimiter({
        name: 'test-limiter',
        capacity: 2,
        refillRatePerSec: 10, // 10 tokens per second = 1 token per 100ms
      });

      expect(limiter.tryAcquire(2)).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);

      // Wait 150ms to gain at least 1 token
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(limiter.tryAcquire()).toBe(true);
    });

    it('should abort acquire if signal is cancelled', async () => {
      const limiter = new TokenBucketRateLimiter({
        name: 'test-abort',
        capacity: 1,
        refillRatePerSec: 0.1, // very slow refill
      });

      limiter.tryAcquire(1); // empty

      const controller = new AbortController();
      const acquirePromise = limiter.acquire(1, controller.signal);

      controller.abort(new Error('Caller cancelled request'));

      await expect(acquirePromise).rejects.toThrow(
        'Caller cancelled request',
      );
    });
  });

  describe('ResilienceRegistryService', () => {
    let registry: ResilienceRegistryService;

    beforeEach(() => {
      registry = new ResilienceRegistryService();
      registry.resetAll();
    });

    it('should have preconfigured academic providers with polite SLAs', () => {
      const arxivBreaker = registry.getCircuitBreaker('arxiv');
      const arxivLimiter = registry.getRateLimiter('arxiv');

      expect(arxivBreaker.failureThreshold).toBe(3);
      expect(arxivLimiter.refillRatePerSec).toBeCloseTo(0.33, 2); // 1 req per 3s
      expect(arxivLimiter.capacity).toBe(1);

      const crossrefLimiter = registry.getRateLimiter('crossref');
      expect(crossrefLimiter.capacity).toBe(10);
      expect(crossrefLimiter.refillRatePerSec).toBe(10);
    });

    it('should coordinate rate limiter and circuit breaker via execute', async () => {
      const fn = jest.fn().mockResolvedValue('coordinated-result');

      const res = await registry.execute('doi-org', fn);

      expect(res).toBe('coordinated-result');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('DoiContentNegotiationService Integration', () => {
    let registry: ResilienceRegistryService;
    let service: DoiContentNegotiationService;
    const originalFetch = global.fetch;

    beforeEach(() => {
      registry = new ResilienceRegistryService();
      registry.resetAll();
      service = new DoiContentNegotiationService(registry);
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should trip circuit breaker on repeated 500 errors and fast-fail subsequent calls in 0ms', async () => {
      // Mock global fetch returning HTTP 503
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      } as any);

      const doiBreaker = registry.getCircuitBreaker('doi-org');

      // Fail 4 times (threshold = 4)
      await service.resolveCitation('10.1000/182_fail1');
      await service.resolveCitation('10.1000/182_fail2');
      await service.resolveCitation('10.1000/182_fail3');
      await service.resolveCitation('10.1000/182_fail4');

      expect(doiBreaker.getState()).toBe('OPEN');

      // 5th call: Circuit breaker is OPEN. Global fetch must NOT be called again!
      (global.fetch as jest.Mock).mockClear();

      const startTime = performance.now();
      const res = await service.resolveCitation('10.1000/182_fail5');
      const durationMs = performance.now() - startTime;

      expect(res).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled(); // Fast-failed!
      expect(durationMs).toBeLessThan(50); // Instant 0ms response!
    });
  });

  describe('GrobidClient Integration', () => {
    let registry: ResilienceRegistryService;
    let grobid: GrobidClient;
    const originalFetch = global.fetch;

    beforeEach(() => {
      registry = new ResilienceRegistryService();
      registry.resetAll();
      grobid = new GrobidClient(registry);
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should trip grobid circuit breaker and fast-fail without network request', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      } as any);

      const grobidBreaker = registry.getCircuitBreaker('grobid');

      const mockBuffer = Buffer.from('%PDF-1.4 mock');

      // Fail 3 times (threshold = 3)
      await grobid.processHeaderDocument(mockBuffer);
      await grobid.processHeaderDocument(mockBuffer);
      await grobid.processHeaderDocument(mockBuffer);

      expect(grobidBreaker.getState()).toBe('OPEN');

      // Next call fast-fails immediately
      (global.fetch as jest.Mock).mockClear();
      const headerResult = await grobid.processHeaderDocument(mockBuffer);
      const refsResult = await grobid.processReferences(mockBuffer);
      const fulltextResult = await grobid.processFulltextDocument(mockBuffer);

      expect(headerResult).toBeNull();
      expect(refsResult).toEqual([]);
      expect(fulltextResult).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
