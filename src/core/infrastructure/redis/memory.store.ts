import { LRUCache } from 'lru-cache';

const DEFAULT_MAX_KEYS = 5_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB hard cap on L1 heap

/**
 * Byte- and count-bounded L1 / Fallback In-Memory Cache Store backed by `lru-cache`.
 * True O(1) Least-Recently-Used eviction prevents both key-count leaks and
 * single large-payload heap spikes when Redis is offline or disabled.
 */
export class BoundedMemoryStore {
  private readonly cache: LRUCache<string, string>;

  constructor(maxKeys = DEFAULT_MAX_KEYS, maxBytes = DEFAULT_MAX_BYTES) {
    this.cache = new LRUCache<string, string>({
      max: maxKeys,
      maxSize: maxBytes,
      sizeCalculation: (value) => Math.max(1, Buffer.byteLength(value, 'utf8')),
      ttl: 300_000,
    });
  }

  public get(key: string): string | null {
    const val = this.cache.get(key);
    return val === undefined ? null : val;
  }

  public set(key: string, value: string, ttlSeconds?: number): void {
    const effectiveTtlMs =
      ttlSeconds && ttlSeconds > 0 ? ttlSeconds * 1000 : 300_000;
    this.cache.set(key, value, { ttl: effectiveTtlMs });
  }

  public hasValid(key: string): boolean {
    const val = this.cache.get(key);
    return val !== undefined && val !== 'null';
  }

  public getRemainingTtlSeconds(key: string): number {
    const remainingMs = this.cache.getRemainingTTL(key);
    if (remainingMs <= 0) return -2;
    return Math.ceil(remainingMs / 1000);
  }

  public delete(key: string): boolean {
    return this.cache.delete(key);
  }

  public deleteMatching(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of Array.from(this.cache.keys())) {
      if (predicate(key)) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.cache.clear();
  }

  public get size(): number {
    return this.cache.size;
  }

  public get calculatedSizeBytes(): number {
    return this.cache.calculatedSize;
  }
}
