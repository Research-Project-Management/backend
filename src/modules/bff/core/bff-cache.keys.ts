/**
 * modules/bff/core/bff-cache.keys.ts
 * Standardized Redis cache keys and short TTLs for channel-specific BFF views.
 */

import type { BffClientChannel } from './bff.types';

export const BFF_CACHE_TTL_SECONDS = {
  workspaceShell: 20,
  projectBootstrap: 15,
} as const;

export const BFF_CACHE_KEYS = {
  workspaceShell: (channel: BffClientChannel, userId: string): string =>
    `flux:bff:${channel}:workspace-shell:${userId}`,

  projectBootstrap: (
    channel: BffClientChannel,
    projectId: string,
    userId: string,
  ): string => `flux:bff:${channel}:project-bootstrap:${projectId}:${userId}`,
} as const;
