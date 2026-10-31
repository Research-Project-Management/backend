/**
 * High-performance, zero-dependency Bloom Filter for instant 0ms pre-screening of Retraction DOIs and PMIDs.
 *
 * Mathematical properties:
 * Given n elements and false positive probability p:
 *   m = - (n * ln(p)) / (ln(2)^2)   (bits required)
 *   k = (m / n) * ln(2)             (optimal hash functions)
 *
 * For n = 60,000 retraction records and p = 0.01 (1% false positive):
 *   m = 575,103 bits (~71.8 KB of RAM)
 *   k = 7 hash functions
 *
 * Guaranteed invariant:
 * - Zero False Negatives: If contains() returns FALSE, the DOI is 100% NOT in the retraction database.
 * - Minimal False Positives (1%): If contains() returns TRUE, we confirm with Redis / PostgreSQL.
 */
export class RetractionBloomFilter {
  private readonly sizeBits: number;
  private readonly numHashes: number;
  private readonly bitArray: Uint8Array;
  private itemCount = 0;
  private ready = false;

  constructor(expectedItems = 60000, falsePositiveRate = 0.01) {
    const p = Math.max(0.0001, Math.min(0.1, falsePositiveRate));
    const n = Math.max(1000, expectedItems);

    const m = Math.ceil(-((n * Math.log(p)) / (Math.LN2 * Math.LN2)));
    this.sizeBits = m;
    this.numHashes = Math.max(2, Math.round((m / n) * Math.LN2));
    this.bitArray = new Uint8Array(Math.ceil(m / 8));
  }

  /**
   * 32-bit FNV-1a Hash function
   */
  public static fnv1a(str: string, seed = 0x811c9dc5): number {
    let hash = seed;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * 32-bit Murmur-inspired bit mixer
   */
  private static murmurMix(hash: number): number {
    let h = hash;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }

  /**
   * Kirsch-Mitzenmacher Double-Hashing technique:
   * Generates k distinct hash indexes using only two hash calculations:
   *   g_i(x) = (h1(x) + i * h2(x)) mod m
   */
  private getHashIndexes(key: string): number[] {
    const h1 = RetractionBloomFilter.fnv1a(key, 0x811c9dc5);
    const h2 =
      RetractionBloomFilter.murmurMix(
        RetractionBloomFilter.fnv1a(key, 0x9e3779b9),
      ) | 1; // ensure odd number to cover full bit range

    const indexes: number[] = new Array(this.numHashes);
    for (let i = 0; i < this.numHashes; i++) {
      const combined = (h1 + Math.imul(i, h2)) >>> 0;
      indexes[i] = combined % this.sizeBits;
    }
    return indexes;
  }

  /**
   * Adds a normalized DOI or PMID to the Bloom Filter
   */
  add(key: string): void {
    if (!key) return;
    const cleanKey = key.trim().toLowerCase();
    if (!cleanKey) return;
    const indexes = this.getHashIndexes(cleanKey);

    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i];
      const byteIdx = idx >> 3;
      const bitMask = 1 << (idx & 7);
      this.bitArray[byteIdx] |= bitMask;
    }
    this.itemCount++;
  }

  /**
   * Tests whether a key MIGHT be in the set, or is DEFINITELY NOT in the set.
   * Returns:
   *   false => Definitely not retracted (100% confident, 0ms fast path)
   *   true  => Possibly retracted (verify with PostgreSQL)
   */
  contains(key: string): boolean {
    if (!key) return false;
    const cleanKey = key.trim().toLowerCase();
    if (!cleanKey) return false;
    const indexes = this.getHashIndexes(cleanKey);

    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i];
      const byteIdx = idx >> 3;
      const bitMask = 1 << (idx & 7);
      if ((this.bitArray[byteIdx] & bitMask) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Resets all bits in the Bloom Filter
   */
  clear(): void {
    this.bitArray.fill(0);
    this.itemCount = 0;
    this.ready = false;
  }

  markReady(isReady = true): void {
    this.ready = isReady;
  }

  isReady(): boolean {
    return this.ready && this.itemCount > 0;
  }

  getItemCount(): number {
    return this.itemCount;
  }

  getMemorySizeBytes(): number {
    return this.bitArray.byteLength;
  }
}
