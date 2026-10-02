/**
 * In-Memory Mock Redis Service Provider (Zero-IO)
 * Prevents hanging sockets and eliminates dependency on live Redis instances during tests.
 */
export function createMockRedisService() {
  const store = new Map<string, string>();

  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      const existed = store.delete(key);
      return existed ? 1 : 0;
    }),
    exists: jest.fn(async (key: string) => (store.has(key) ? 1 : 0)),
    keys: jest.fn(async (pattern: string) => {
      const regex = new RegExp(`^${pattern.replace('*', '.*')}$`);
      return Array.from(store.keys()).filter((k) => regex.test(k));
    }),
    flushall: jest.fn(async () => {
      store.clear();
      return 'OK';
    }),
    clearInternalStore: () => store.clear(),
  };
}
