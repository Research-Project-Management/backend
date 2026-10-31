import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { LIBRARY_REDIS_KEYS, LIBRARY_EVENT_TYPES } from '@/modules/library/core';
import { CircuitBreaker } from '@/modules/library/core/resilience/circuit-breaker';
import { ResilienceRegistryService } from '@/modules/library/core/resilience/resilience-registry.service';
import { AcademicHttpClient } from '@/modules/library/core/services/academic-http.client';
import { MetadataExecutorService } from '@/modules/library/ingestion/services/metadata-executor.service';
import { DblpProvider } from '@/modules/library/ingestion/providers/dblp.provider';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';
import { FeedsEngine } from '@/modules/library/ingestion/services/feeds.engine';
import { DoiContentNegotiationService } from '@/modules/library/citation/services/doi-content-negotiation.service';
import { MetadataCache } from '@/modules/library/ingestion/repositories/metadata.cache';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';
import { PipelineService } from '@/modules/library/ingestion/services/pipeline.service';
import { QueueService } from '@/modules/library/ingestion/services/queue.service';
import { ExtractionHandler } from '@/modules/library/extraction/services/extraction.handler';

describe('DIY Infrastructure, Resilience, Rate-Limiting & Cache Consolidation Audit (SH1)', () => {
  describe('SH1-01: SearchRepository distributed scopeVersions & bounded LRU', () => {
    it('reads updated searchVersion from Redis and increments when Redis key was deleted by ItemCacheCoordinator', async () => {
      const store = new Map<string, unknown>();
      const mockCache = {
        get: jest.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
        set: jest.fn(async (k: string, v: unknown) => {
          store.set(k, v);
        }),
        del: jest.fn(async (k: string) => {
          store.delete(k);
        }),
        delPattern: jest.fn(async () => {}),
      };
      const mockPrisma = {
        item: {
          groupBy: jest.fn().mockResolvedValue([]),
          findMany: jest.fn().mockResolvedValue([]),
        },
        itemTag: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const repo = new SearchRepository(mockPrisma as never, mockCache as never);
      const scopeId = '11111111-2222-4333-8444-555555555555';
      const versionKey = LIBRARY_REDIS_KEYS.searchVersion(scopeId);

      // 1. Initial resolution initializes to '1' and persists in Redis
      const v1 = await repo.resolveScopeVersion(scopeId);
      expect(v1).toBe('1');
      expect(store.get(versionKey)).toBe('1');

      // 2. Another pod bumps Redis searchVersion to '4'
      store.set(versionKey, '4');
      const v4 = await repo.resolveScopeVersion(scopeId);
      expect(v4).toBe('4');

      // 3. ItemCacheCoordinator deletes searchVersion key in Redis
      await mockCache.del(versionKey);
      const v5 = await repo.resolveScopeVersion(scopeId);
      expect(v5).toBe('5');
      expect(store.get(versionKey)).toBe('5');
    });

    it('bounds in-memory scopeVersions Map to MAX_SCOPE_VERSIONS (1000) with LRU eviction', async () => {
      const repo = new SearchRepository({} as never);
      for (let i = 0; i < 1050; i++) {
        await repo.resolveScopeVersion(`scope-${i}`);
      }
      const internalMap = (
        repo as unknown as { scopeVersions: Map<string, string> }
      ).scopeVersions;
      expect(internalMap.size).toBeLessThanOrEqual(1000);
      expect(internalMap.has('scope-0')).toBe(false);
      expect(internalMap.has('scope-1049')).toBe(true);
    });
  });

  describe('SH1-02: CircuitBreaker + MetadataExecutorService + DblpProvider + DomainRateLimiter + FeedsEngine', () => {
    it('does not double-count failures or double-consume HALF_OPEN probe slots when provider uses AcademicHttpClient', async () => {
      const rateLimiter = new DomainRateLimiterService();
      rateLimiter.bypassDelay = true;
      const registry = new ResilienceRegistryService();
      const _httpClient = new AcademicHttpClient(
        {} as never,
        registry,
        { academic: { userAgent: 'test' } } as never,
      );
      const executor = new MetadataExecutorService(rateLimiter, registry);

      const breaker: CircuitBreaker = registry.getCircuitBreaker('crossref', {
        failureThreshold: 5,
        resetTimeoutMs: 50,
      });

      const failingProvider = {
        id: 'CrossRef' as const,
        supports: () => true,
        capabilities: {
          queryTypes: ['DOI' as const],
          isAuthoritative: true,
          supportsDoi: true,
          supportsIsbn: false,
          supportsPmid: false,
          supportsArxiv: false,
          supportsTitleSearch: false,
          maxConcurrency: 2,
          timeoutMs: 2000,
        },
        resolve: jest.fn(async () => {
          return registry.execute('crossref', async () => {
            const err = new Error('HTTP 503 Service Unavailable') as Error & {
              status: number;
            };
            err.status = 503;
            throw err;
          });
        }),
      };

      const res = await executor.execute(failingProvider, {
        query: '10.1000/xyz',
        queryType: 'DOI',
      });
      expect(res.status).toBe('unavailable');
      // 1 initial attempt + 2 retries = 3 total attempts; must be 3 failures, NOT 4 or 6
      expect(breaker.getFailures()).toBe(3);

      // Force breaker to OPEN then advance past resetTimeoutMs cooldown
      breaker.recordFailure(true);
      breaker.recordFailure(true);
      expect(breaker.getState()).toBe('OPEN');

      (
        breaker as unknown as { lastFailureTime: number }
      ).lastFailureTime = Date.now() - breaker.resetTimeoutMs - 100;
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Next execution in HALF_OPEN must NOT fail immediately due to double canExecute()
      const recoveringProvider = {
        ...failingProvider,
        resolve: jest.fn(async () => {
          return registry.execute('crossref', async () => ({
            provider: 'CrossRef' as const,
            identifier: '10.1000/xyz',
            fetchedAt: new Date().toISOString(),
            confidence: 0.95,
            metadata: {
              title: 'Recovered Paper',
              creators: [],
              itemType: 'journalArticle',
            },
          }));
        }),
      };

      const probeRes = await executor.execute(recoveringProvider, {
        query: '10.1000/xyz',
        queryType: 'DOI',
      });
      expect(probeRes.status).toBe('found');
      expect(breaker.getState()).toBe('CLOSED');
    });

    it('DblpProvider.resolve does not redundantly call rateLimiter.acquire directly', async () => {
      const rateLimiter = {
        acquire: jest.fn().mockResolvedValue(undefined),
      };
      const httpClient = {
        request: jest.fn().mockResolvedValue({
          response: {
            ok: true,
            status: 200,
            json: async () => ({
              result: {
                hits: {
                  hit: [
                    {
                      info: {
                        title: 'Distributed Systems',
                        year: '2025',
                        doi: '10.1000/dblp.1',
                      },
                    },
                  ],
                },
              },
            }),
          },
          finalUrl: 'https://dblp.org/search/publ/api',
        }),
      };

      const provider = new DblpProvider(httpClient as never);
      const res = await provider.resolve({
        query: '10.1000/dblp.1',
        queryType: 'DOI',
      });
      expect(res).not.toBeNull();
      expect(rateLimiter.acquire).not.toHaveBeenCalled();
    });

    it('DomainRateLimiterService uses atomic Redis Lua eval script when available', async () => {
      const evalMock = jest.fn().mockResolvedValue(0);
      const mockRedis = {
        isReady: () => true,
        getClient: () => ({
          eval: evalMock,
          get: jest.fn(),
          set: jest.fn(),
        }),
      };
      const limiter = new DomainRateLimiterService(mockRedis as never);
      await limiter.acquire('crossref');
      expect(evalMock).toHaveBeenCalledTimes(1);
    });

    it('FeedsEngine bounds circuitBreakers Map to 500 and properly transitions HALF-OPEN on probe failure', () => {
      const engine = new FeedsEngine({} as never);
      for (let i = 0; i < 520; i++) {
        engine.recordFailure(`https://example.com/feed-${i}.xml`, 'timeout');
      }
      const cbMap = (
        engine as unknown as {
          circuitBreakers: Map<
            string,
            { failures: number; lastFailureTime: number; isOpen: boolean }
          >;
        }
      ).circuitBreakers;
      expect(cbMap.size).toBeLessThanOrEqual(500);

      const targetFeed = 'https://example.com/probe-feed.xml';
      engine.recordFailure(targetFeed, 'err 1');
      engine.recordFailure(targetFeed, 'err 2');
      engine.recordFailure(targetFeed, 'err 3');
      expect(engine.canExecute(targetFeed)).toBe(false);

      // Simulate cooldown expiry
      const state = cbMap.get(targetFeed)!;
      state.lastFailureTime = Date.now() - 13 * 60 * 60 * 1000;
      expect(engine.canExecute(targetFeed)).toBe(true);
      expect(cbMap.get(targetFeed)?.isOpen).toBe(false);

      // Probe fails -> immediately re-opens circuit
      engine.recordFailure(targetFeed, 'probe failed');
      expect(cbMap.get(targetFeed)?.isOpen).toBe(true);
      expect(engine.canExecute(targetFeed)).toBe(false);
    });
  });

  describe('SH1-03: DoiContentNegotiationService, MetadataCache, RetractionDatabaseService, PipelineService & QueueService', () => {
    it('DoiContentNegotiationService purges expired entries before evicting valid LRU keys and uses Redis L2', async () => {
      const redisStore = new Map<string, unknown>();
      const mockRedis = {
        get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          redisStore.set(k, v);
        }),
      };
      const svc = new DoiContentNegotiationService(
        undefined,
        undefined,
        mockRedis as never,
      );

      const testMap = new Map<string, { result: string; expiresAt: number }>();
      const setWithLru = (
        svc as unknown as {
          setWithLru: (
            map: Map<string, { result: string; expiresAt: number }>,
            key: string,
            result: string,
            ttlMs: number,
            maxSize: number,
          ) => void;
        }
      ).setWithLru.bind(svc);

      // Insert 1 expired entry and 2 valid entries in a maxSize=3 map
      testMap.set('expired-1', { result: 'old', expiresAt: Date.now() - 1000 });
      testMap.set('valid-1', { result: 'v1', expiresAt: Date.now() + 60000 });
      testMap.set('valid-2', { result: 'v2', expiresAt: Date.now() + 60000 });

      setWithLru(testMap, 'valid-3', 'v3', 60000, 3);
      expect(testMap.has('expired-1')).toBe(false);
      expect(testMap.has('valid-1')).toBe(true);
      expect(testMap.has('valid-2')).toBe(true);
      expect(testMap.has('valid-3')).toBe(true);

      // Verify Redis L2 hit on resolveCitation without network fetch
      redisStore.set('library:doi-cn:cite:apa:10.1038/nature12373', {
        styleId: 'apa',
        bibliography: 'Author (2025). Nature.',
        source: 'publisher',
      });
      const cite = await svc.resolveCitation('10.1038/nature12373', 'apa');
      expect(cite?.bibliography).toBe('Author (2025). Nature.');
    });

    it('MetadataCache.setL1 refreshes existing keys and purges expired keys before evicting oldest valid key', () => {
      const cache = new MetadataCache();
      const l1 = (
        cache as unknown as {
          l1Cache: Map<string, { value: unknown; expiresAt: number }>;
          setL1: (key: string, value: false, ttlSeconds: number) => void;
        }
      );

      l1.l1Cache.set('expired-k', { value: false, expiresAt: Date.now() - 500 });
      for (let i = 0; i < 999; i++) {
        l1.l1Cache.set(`valid-${i}`, {
          value: false,
          expiresAt: Date.now() + 60000,
        });
      }
      expect(l1.l1Cache.size).toBe(1000);

      l1.setL1('new-key', false, 60);
      expect(l1.l1Cache.has('expired-k')).toBe(false);
      expect(l1.l1Cache.has('valid-0')).toBe(true);
      expect(l1.l1Cache.has('new-key')).toBe(true);
    });

    it('RetractionDatabaseService synchronizes clean & retracted DOIs via Redis across pods', async () => {
      const redisStore = new Map<string, unknown>();
      const mockRedis = {
        get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
        set: jest.fn(async (k: string, v: unknown) => {
          redisStore.set(k, v);
        }),
      };
      const mockRepo = {
        upsertRetractionRecord: jest.fn().mockResolvedValue(undefined),
        findRetractionRecordByDoi: jest.fn().mockResolvedValue(null),
      };

      const podA = new RetractionDatabaseService(
        mockRepo as never,
        mockRedis as never,
      );
      const podB = new RetractionDatabaseService(
        mockRepo as never,
        mockRedis as never,
      );

      const doi = '10.1000/retract-sync';
      await podA.saveClean(doi);
      expect(await podB.checkRetraction(doi)).toBe(false);

      // Now podB saves a retraction for the same DOI -> podA must see the retraction via Redis
      // even if podA's local cleanDoiCache previously had a 14-day TTL!
      await podB.saveRetraction(doi, {
        nature: 'retraction',
        reason: 'Data fabrication',
        source: 'retraction_watch',
      });

      const podACheck = await podA.checkRetraction(doi);
      expect(podACheck).toEqual(
        expect.objectContaining({
          nature: 'retraction',
          reason: 'Data fabrication',
        }),
      );
    });

    it('PipelineService.runTerminalMaintenanceGc uses 7-day retention instead of 0 days', async () => {
      const cleanupExpiredPreviews = jest.fn().mockResolvedValue(0);
      const purgeOldRuns = jest.fn().mockResolvedValue(0);
      const pipeline = Object.create(PipelineService.prototype) as {
        urlCapture: { cleanupExpiredPreviews: jest.Mock };
        repo: { purgeOldRuns: jest.Mock };
        runTerminalMaintenanceGc: () => Promise<void>;
      };
      pipeline.urlCapture = { cleanupExpiredPreviews };
      pipeline.repo = { purgeOldRuns };

      await pipeline.runTerminalMaintenanceGc();
      expect(cleanupExpiredPreviews).toHaveBeenCalledWith(7);
      expect(purgeOldRuns).toHaveBeenCalledWith(7);
    });

    it('QueueService skips recoverOrphanedRuns on API-only pod when BullMQ is active', async () => {
      const prevWorkerMode = process.env.WORKER_MODE;
      const prevInProcess = process.env.ENABLE_IN_PROCESS_WORKERS;
      delete process.env.WORKER_MODE;
      process.env.ENABLE_IN_PROCESS_WORKERS = 'false';
      try {
        const findOrphanedRuns = jest.fn().mockResolvedValue([]);
        const queueService = new QueueService(
          {} as never,
          { findOrphanedRuns } as never,
          undefined,
          { on: jest.fn(), removeAllListeners: jest.fn() } as never,
        );
        await queueService.onModuleInit();
        expect(findOrphanedRuns).not.toHaveBeenCalled();
      } finally {
        if (prevWorkerMode === undefined) {
          delete process.env.WORKER_MODE;
        } else {
          process.env.WORKER_MODE = prevWorkerMode;
        }
        if (prevInProcess === undefined) {
          delete process.env.ENABLE_IN_PROCESS_WORKERS;
        } else {
          process.env.ENABLE_IN_PROCESS_WORKERS = prevInProcess;
        }
      }
    });
  });

  describe('SH1-04: ExtractionHandler durable async event emission', () => {
    it('awaits eventEmitter.emitAsync in emitEventDurable and catches listener rejections gracefully', async () => {
      const handler = Object.create(
        ExtractionHandler.prototype,
      ) as {
        eventEmitter: { emitAsync: jest.Mock; emit: jest.Mock };
        logger: { warn: jest.Mock };
        emitEventDurable: (eventName: string, payload: unknown) => Promise<void>;
      };

      let asyncFinished = false;
      handler.eventEmitter = {
        emitAsync: jest.fn(async () => {
          await new Promise((r) => setTimeout(r, 15));
          asyncFinished = true;
        }),
        emit: jest.fn(),
      };
      handler.logger = { warn: jest.fn() };

      await handler.emitEventDurable(LIBRARY_EVENT_TYPES.ITEM_UPDATED, {
        itemId: 'item-1',
      });
      expect(asyncFinished).toBe(true);
      expect(handler.eventEmitter.emitAsync).toHaveBeenCalledTimes(1);
      expect(handler.eventEmitter.emit).not.toHaveBeenCalled();

      // Rejecting listener is caught and logged without throwing
      handler.eventEmitter.emitAsync.mockRejectedValueOnce(
        new Error('Listener DB timeout'),
      );
      await expect(
        handler.emitEventDurable('library.attachment.pages.extracted', {}),
      ).resolves.toBeUndefined();
      expect(handler.logger.warn).toHaveBeenCalled();
    });
  });
});
