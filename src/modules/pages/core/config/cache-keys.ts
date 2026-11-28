/**
 * modules/pages/core/config/cache-keys.ts
 * Centralized Redis key builders for the Pages domain.
 */
export const PAGES_CACHE_KEYS = {
  clsiCompile: (hash: string) => `flux:clsi:compile:${hash}`,
} as const;
