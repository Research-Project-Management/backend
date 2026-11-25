/**
 * modules/pages/clsi/domain/lru-cache.ts
 * O(1) bounded Least-Recently-Used (LRU) cache backed by Map insertion order.
 */

export class BoundedLruCache<K, V> {
  private readonly store = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (maxEntries < 1) {
      throw new RangeError('BoundedLruCache maxEntries must be >= 1');
    }
  }

  public get size(): number {
    return this.store.size;
  }

  public get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  public set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, value);
  }

  public delete(key: K): boolean {
    return this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}
