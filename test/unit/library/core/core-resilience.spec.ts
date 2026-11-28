import {
  CircuitBreaker,
  CircuitBreakerOpenError,
  TokenBucketRateLimiter,
  SingleFlightCoalescer,
  ResilienceRegistryService,
  readSafeResponseBuffer,
  MAX_SAFE_HTTP_PAYLOAD_BYTES,
  PayloadTooLargeException,
} from '@/modules/library/core';

describe('Library Core Resilience & Safe Stream Buffering', () => {
  describe('CircuitBreaker & TokenBucketRateLimiter', () => {
    it('transitions CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN and supports fallbacks', async () => {
      const breaker = new CircuitBreaker({
        name: 'test-api',
        failureThreshold: 2,
        resetTimeoutMs: 15,
        halfOpenMaxAttempts: 1,
      });

      expect(await breaker.execute(async () => 'ok')).toBe('ok');
      await expect(
        breaker.execute(async () => {
          throw new Error('503');
        }),
      ).rejects.toThrow('503');
      await expect(
        breaker.execute(async () => {
          throw new Error('503');
        }),
      ).rejects.toThrow('503');
      expect(breaker.getState()).toBe('OPEN');

      await expect(breaker.execute(async () => 'blocked')).rejects.toThrow(
        CircuitBreakerOpenError,
      );
      expect(
        await breaker.execute(
          async () => 'blocked',
          async () => 'fallback',
        ),
      ).toBe('fallback');

      await new Promise((r) => setTimeout(r, 25));
      expect(breaker.getState()).toBe('HALF_OPEN');
      expect(await breaker.execute(async () => 'recovered')).toBe('recovered');
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('enforces token-bucket burst capacity, refills over time, and aborts on signal cancellation', async () => {
      const limiter = new TokenBucketRateLimiter({
        name: 'test-limiter',
        capacity: 2,
        refillRatePerSec: 100,
      });

      expect(limiter.tryAcquire(2)).toBe(true);
      expect(limiter.tryAcquire(1)).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(limiter.tryAcquire(1)).toBe(true);

      const slowLimiter = new TokenBucketRateLimiter({
        name: 'slow',
        capacity: 1,
        refillRatePerSec: 0.1,
      });
      slowLimiter.tryAcquire(1);
      const controller = new AbortController();
      const pending = slowLimiter.acquire(1, controller.signal);
      controller.abort(new Error('Cancelled'));
      await expect(pending).rejects.toThrow('Cancelled');
    });
  });

  describe('SingleFlightCoalescer & ResilienceRegistryService', () => {
    it('coalesces concurrent in-flight operations and cleans up on rejection', async () => {
      const coalescer = new SingleFlightCoalescer();
      let executions = 0;

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          coalescer.execute('key', async () => {
            executions++;
            await new Promise((r) => setTimeout(r, 2));
            return 'shared';
          }),
        ),
      );
      expect(executions).toBe(1);
      expect(results.every((r) => r === 'shared')).toBe(true);
      expect(coalescer.inFlightCount).toBe(0);

      let flakyAttempts = 0;
      await expect(
        coalescer.execute('flaky', async () => {
          flakyAttempts++;
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(
        await coalescer.execute('flaky', async () => {
          flakyAttempts++;
          return 'ok';
        }),
      ).toBe('ok');
      expect(flakyAttempts).toBe(2);
    });

    it('normalizes provider hostnames and ignores 404 client errors in circuit breaker state', async () => {
      const registry = new ResilienceRegistryService();
      registry.resetAll();

      expect(registry.normalizeKey('export.arxiv.org')).toBe('arxiv');
      expect(registry.normalizeKey('api.semanticscholar.org')).toBe(
        'semantic-scholar',
      );
      expect(registry.normalizeKey('eutils.ncbi.nlm.nih.gov')).toBe('pubmed');
      expect(registry.getCircuitBreaker('export.arxiv.org')).toBe(
        registry.getCircuitBreaker('arxiv'),
      );

      const crossrefBreaker = registry.getCircuitBreaker('crossref');
      for (let i = 0; i < 5; i++) {
        await expect(
          crossrefBreaker.execute(async () => {
            throw new Error('CrossRef HTTP 404 Not Found');
          }),
        ).rejects.toThrow('CrossRef HTTP 404 Not Found');
      }
      expect(crossrefBreaker.getState()).toBe('CLOSED');
    });
  });

  describe('readSafeResponseBuffer', () => {
    it('reads bounded streams and rejects oversized Content-Length or streaming payloads', async () => {
      const sampleBytes = new TextEncoder().encode('Academic PDF Sample');
      let delivered = false;
      const okReader = {
        read: jest.fn(async () => {
          if (!delivered) {
            delivered = true;
            return { done: false, value: sampleBytes };
          }
          return { done: true, value: undefined };
        }),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      };
      const okResp = {
        headers: { get: () => String(sampleBytes.length) },
        body: { getReader: () => okReader },
      } as unknown as Response;

      expect((await readSafeResponseBuffer(okResp, 1024)).toString()).toBe(
        'Academic PDF Sample',
      );
      expect(okReader.releaseLock).toHaveBeenCalled();

      const headerTooLarge = {
        headers: { get: () => String(MAX_SAFE_HTTP_PAYLOAD_BYTES + 1024) },
        body: { getReader: () => okReader },
      } as unknown as Response;
      await expect(
        readSafeResponseBuffer(headerTooLarge, MAX_SAFE_HTTP_PAYLOAD_BYTES),
      ).rejects.toThrow(PayloadTooLargeException);

      const streamCancel = jest.fn().mockResolvedValue(undefined);
      const streamRelease = jest.fn();
      const hugeChunkReader = {
        read: jest
          .fn()
          .mockResolvedValue({ done: false, value: new Uint8Array(2048) }),
        cancel: streamCancel,
        releaseLock: streamRelease,
      };
      const streamingTooLarge = {
        headers: { get: () => null },
        body: { getReader: () => hugeChunkReader },
      } as unknown as Response;

      await expect(
        readSafeResponseBuffer(streamingTooLarge, 1024),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(streamCancel).toHaveBeenCalled();
      expect(streamRelease).toHaveBeenCalled();
    });
  });
});
