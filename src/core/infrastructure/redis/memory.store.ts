/**
 * Bounded L1 / Fallback In-Memory Cache Store (Strategy).
 * Keeps memory usage capped even when Redis is unavailable or disabled in tests.
 */
export class BoundedMemoryStore {
  private readonly store = new Map<
    string,
    { value: string; expiresAt?: number }
  >();

  constructor(private readonly maxSize = 5000) {}

  public get(key: string): string | null {
    const item = this.store.get(key);
    if (!item) return null;

    if (item.expiresAt !== undefined && item.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }

    return item.value;
  }

  public hasValid(key: string): boolean {
    const val = this.get(key);
    return val !== null && val !== 'null';
  }

  public getRemainingTtlSeconds(key: string): number {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt === undefined) return -2;
    const remainingMs = entry.expiresAt - Date.now();
    if (remainingMs <= 0) {
      this.store.delete(key);
      return -2;
    }
    return Math.ceil(remainingMs / 1000);
  }

  public set(key: string, value: string, ttlSeconds?: number): void {
    if (this.store.size >= this.maxSize) {
      this.evictExpiredAndOldest();
    }

    const effectiveTtl = ttlSeconds && ttlSeconds > 0 ? ttlSeconds : 300;
    this.store.set(key, {
      value,
      expiresAt: Date.now() + effectiveTtl * 1000,
    });
  }

  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  public deleteMatching(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of Array.from(this.store.keys())) {
      if (predicate(key)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  public clear(): void {
    this.store.clear();
  }

  public get size(): number {
    return this.store.size;
  }

  private evictExpiredAndOldest(): void {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt !== undefined && v.expiresAt < now) {
        this.store.delete(k);
      }
    }
    while (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (!oldestKey) break;
      this.store.delete(oldestKey);
    }
  }
}
