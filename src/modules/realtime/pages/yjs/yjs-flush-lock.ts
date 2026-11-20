import { RedisCacheService } from '@/core';
import { yjsRedisFlushLockKey } from './yjs.types';

const RELEASE_FLUSH_LOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export async function acquireFlushLockHelper(
  redis: RedisCacheService | undefined,
  instanceId: string,
  projectId: string,
  docId: string,
): Promise<boolean> {
  if (!redis || !redis.isReady()) return true;
  const client = redis.getClient?.();
  if (!client || typeof client.set !== 'function') return true;
  try {
    const lockKey = yjsRedisFlushLockKey(projectId, docId);
    const res = await client.set(lockKey, instanceId, 'PX', 10000, 'NX');
    return res === 'OK';
  } catch {
    return true;
  }
}

export async function releaseFlushLockHelper(
  redis: RedisCacheService | undefined,
  instanceId: string,
  projectId: string,
  docId: string,
): Promise<void> {
  if (!redis || !redis.isReady()) return;
  const client = redis.getClient?.() as
    | {
        eval?: (
          script: string,
          numKeys: number,
          key: string,
          arg: string,
        ) => Promise<unknown>;
        get?: (key: string) => Promise<string | null>;
        del?: (key: string) => Promise<unknown>;
      }
    | undefined;
  if (!client) return;
  try {
    const lockKey = yjsRedisFlushLockKey(projectId, docId);
    if (typeof client.eval === 'function') {
      await client.eval(RELEASE_FLUSH_LOCK_LUA, 1, lockKey, instanceId);
      return;
    }
    const owner = await client.get?.(lockKey);
    if (!owner || owner === instanceId) {
      await client.del?.(lockKey);
    }
  } catch {
    // Ignore lock release error
  }
}
