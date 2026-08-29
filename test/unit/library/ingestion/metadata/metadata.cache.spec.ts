import { MetadataCache } from '@/modules/library/ingestion/metadata/metadata.cache';
import { METADATA_POLICY_VERSION } from '@/modules/library/ingestion/metadata/metadata.policy';

const mockRedis = {
  isReady: jest.fn(() => true),
  get: jest.fn(),
  set: jest.fn(),
};

describe('MetadataCache', () => {
  let cache: MetadataCache;

  beforeEach(() => {
    jest.clearAllMocks();
    cache = new MetadataCache(mockRedis as any);
  });

  describe('buildKey', () => {
    it('includes policy version, queryType, and a hash of canonicalId', () => {
      const key = cache.buildKey('DOI', 'doi:10.1234/foo');
      expect(key).toMatch(
        new RegExp(`^metadata:v${METADATA_POLICY_VERSION}:DOI:[a-f0-9]{32}$`),
      );
    });

    it('produces same key for same inputs (deterministic)', () => {
      expect(cache.buildKey('ARXIV', 'arxiv:1706.03762')).toBe(
        cache.buildKey('ARXIV', 'arxiv:1706.03762'),
      );
    });

    it('produces different key for different query types', () => {
      expect(cache.buildKey('DOI', 'x')).not.toBe(cache.buildKey('ARXIV', 'x'));
    });
  });

  describe('get', () => {
    it('returns null on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await cache.get('key');
      expect(result).toBeNull();
    });

    it('returns false (negative sentinel) on negative cache hit', async () => {
      mockRedis.get.mockResolvedValue('__metadata_negative__');
      const result = await cache.get('key');
      expect(result).toBe(false);
    });

    it('returns ResolvedMetadata object on cache hit', async () => {
      const data = { query: 'test', queryType: 'DOI' } as any;
      mockRedis.get.mockResolvedValue(data);
      const result = await cache.get('key');
      expect(result).toEqual(data);
    });

    it('returns null when Redis unavailable (isReady=false)', async () => {
      mockRedis.isReady.mockReturnValue(false);
      const result = await cache.get('key');
      expect(result).toBeNull();
      expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('returns null when Redis.get throws', async () => {
      mockRedis.isReady.mockReturnValue(true);
      mockRedis.get.mockRejectedValue(new Error('connection refused'));
      await expect(cache.get('key')).resolves.toBeNull();
    });
  });

  describe('set', () => {
    it('stores value with 7-day TTL for DOI', async () => {
      await cache.set('key', { query: 'x' } as any, 'DOI');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key',
        expect.anything(),
        7 * 86_400,
      );
    });

    it('stores value with 14-day TTL for ISBN', async () => {
      await cache.set('key', { query: 'x' } as any, 'ISBN');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key',
        expect.anything(),
        14 * 86_400,
      );
    });

    it('stores value with 24-hour TTL for TITLE', async () => {
      await cache.set('key', { query: 'x' } as any, 'TITLE');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key',
        expect.anything(),
        86_400,
      );
    });

    it('no-ops when Redis unavailable', async () => {
      mockRedis.isReady.mockReturnValue(false);
      await cache.set('key', { query: 'x' } as any, 'DOI');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('setNegative', () => {
    it('stores negative sentinel with 1-hour TTL for DOI', async () => {
      mockRedis.isReady.mockReturnValue(true);
      await cache.setNegative('key', 'DOI');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key',
        '__metadata_negative__',
        3_600,
      );
    });

    it('stores negative sentinel with 15-min TTL for TITLE', async () => {
      await cache.setNegative('key', 'TITLE');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'key',
        '__metadata_negative__',
        900,
      );
    });
  });

  describe('available', () => {
    it('returns true when Redis isReady', () => {
      mockRedis.isReady.mockReturnValue(true);
      expect(cache.available).toBe(true);
    });

    it('returns false when no Redis injected', () => {
      const noRedisCache = new MetadataCache(undefined);
      expect(noRedisCache.available).toBe(false);
    });
  });
});
