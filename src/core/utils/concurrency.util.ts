/**
 * core/utils/concurrency.util.ts
 *
 * Lightweight, ordered worker pool for concurrent async workloads.
 *
 * - mapWithConcurrency: runs up to `limit` workers simultaneously, preserving
 *   input order in the output array. Aborts scheduling immediately on first error.
 * - mapSettledWithConcurrency: never rejects; returns Settled<R>[] for fault-tolerant batching.
 */

export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  if (total === 0) return results;

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, total));
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= total) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { ok: true, value: await fn(item, index) };
    } catch (error) {
      return { ok: false, error };
    }
  });
}
