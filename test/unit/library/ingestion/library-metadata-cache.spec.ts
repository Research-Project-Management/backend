import { MetadataCache } from '@/modules/library/ingestion/repositories/metadata.cache';
import { MetadataService } from '@/modules/library/ingestion/services/metadata.service';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { ResolvedMetadata } from '@/modules/library/ingestion/types/metadata.types';

describe('Multi-Tier Metadata Cache & Local Database Resolution', () => {
  describe('MetadataCache (L1 Memory LRU + L2 Redis)', () => {
    let cache: MetadataCache;
    let mockRedis: any;

    const mockResolved: ResolvedMetadata = {
      query: '10.1038/s41586-020-2649-2',
      queryType: 'DOI',
      canonicalId: 'doi:10.1038/s41586-020-2649-2',
      metadata: {
        title: 'Deep learning for classical molecular dynamics',
        year: 2020,
        provenance: {
          originProvider: 'crossref',
          resolvedAt: new Date().toISOString(),
          canonicalId: 'doi:10.1038/s41586-020-2649-2',
          confidenceScore: 1.0,
          isOpenAccess: true,
        },
      },
      provenance: {},
      cached: false,
      resolvedAt: new Date().toISOString(),
      policyVersion: 2,
    };

    beforeEach(() => {
      const redisStore = new Map<string, any>();
      mockRedis = {
        isReady: jest.fn().mockReturnValue(true),
        get: jest.fn(async (key: string) => redisStore.get(key) || null),
        set: jest.fn(async (key: string, val: any) => redisStore.set(key, val)),
      };
      cache = new MetadataCache(mockRedis);
    });

    it('should store in L1 in-memory cache and retrieve in 0ms without hitting Redis', async () => {
      const key = cache.buildKey('DOI', '10.1038/s41586-020-2649-2');

      await cache.set(key, mockResolved, 'DOI');
      expect(mockRedis.set).toHaveBeenCalled();

      // Clear mockRedis.get call count
      mockRedis.get.mockClear();

      // Read from cache: should be served by L1 in-memory cache!
      const hit = await cache.get(key);
      expect(hit).not.toBeNull();
      expect(hit).not.toBe(false);
      if (hit) {
        expect(hit.metadata.title).toBe(mockResolved.metadata.title);
      }
      // Verified: Redis GET was NOT called because L1 hit first!
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should fallback to L2 Redis on L1 miss and populate L1 for future calls', async () => {
      const key = cache.buildKey('DOI', '10.1016/j.cell.2021.01.001');

      // Seed directly into L2 Redis
      await mockRedis.set(key, JSON.stringify(mockResolved));

      // L1 is empty initially
      const hit1 = await cache.get(key);
      expect(hit1).not.toBeNull();
      expect(mockRedis.get).toHaveBeenCalledTimes(1);

      // Second read should now hit L1 in-memory cache!
      mockRedis.get.mockClear();
      const hit2 = await cache.get(key);
      expect(hit2).not.toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('should handle negative caching across L1 and L2', async () => {
      const key = cache.buildKey('DOI', '10.9999/non-existent-doi');

      await cache.setNegative(key, 'DOI');

      // L1 check should return false (known negative)
      const res1 = await cache.get(key);
      expect(res1).toBe(false);

      // Clear L1 memory
      cache.clearMemoryCache();

      // Now should read negative sentinel from L2 Redis and return false
      const res2 = await cache.get(key);
      expect(res2).toBe(false);
    });

    it('should function seamlessly as L1 memory cache even if Redis is completely unavailable', async () => {
      const offlineCache = new MetadataCache(undefined);
      expect(offlineCache.available).toBe(true);

      const key = offlineCache.buildKey('DOI', '10.1038/offline-test');
      await offlineCache.set(key, mockResolved, 'DOI');

      const hit = await offlineCache.get(key);
      expect(hit).not.toBeNull();
      if (hit) {
        expect(hit.metadata.title).toBe(mockResolved.metadata.title);
      }
    });
  });

  describe('MetadataService Local Database Historical Resolution', () => {
    let service: MetadataService;
    let mockCache: MetadataCache;
    let mockReconciler: any;
    let mockExecutor: any;
    let mockPrisma: any;

    beforeEach(() => {
      mockCache = new MetadataCache(undefined);
      mockReconciler = { reconcile: jest.fn() };
      mockExecutor = { execute: jest.fn() };

      mockPrisma = {
        item: {
          findFirst: jest.fn(),
        },
      };

      const ingestionRepo = new IngestionRepository(mockPrisma);

      service = new MetadataService(
        [],
        mockCache,
        mockReconciler,
        mockExecutor,
        ingestionRepo,
      );
    });

    it('should isolate tenant data and not resolve from unscoped local database into shared cache', async () => {
      const doi = '10.1016/j.cell.2020.05.001';

      const resolved = await service.resolve({ query: doi, queryType: 'DOI' });

      expect(resolved).toBeNull();
      expect(mockPrisma.item.findFirst).not.toHaveBeenCalled();
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });
});
