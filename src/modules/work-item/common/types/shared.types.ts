/**
 * Common Minimal Projection Selections & Interfaces
 * Shared across work-item submodules to avoid leaky abstractions across domains.
 */

import { Prisma } from '@prisma/client';
import { isUuid } from '@/core';

export const USER_MINIMAL_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

export interface UserMinimal {
  id: string;
  name: string | null;
  email: string | null;
  avatar: string | null;
}

export interface UserProfileSource {
  id: string;
  email?: string | null;
  name?: string | null;
  avatar?: string | null;
  profile?: { name?: string | null; avatar?: string | null } | null;
}

export function mapUserMinimal(user: UserProfileSource): {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
};
export function mapUserMinimal(user: UserProfileSource | null | undefined): {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
} | null;
export function mapUserMinimal(user: UserProfileSource | null | undefined) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    name: user.profile?.name ?? user.name ?? 'User',
    avatar: user.profile?.avatar ?? user.avatar ?? null,
  };
}

export function buildWorkItemIdOrIdentifierWhere(
  idOrIdentifier: string,
  extra: Record<string, unknown> = { deletedAt: null },
): Prisma.WorkItemWhereInput {
  return isUuid(idOrIdentifier)
    ? { id: idOrIdentifier, ...extra }
    : {
        identifier: { equals: idOrIdentifier, mode: 'insensitive' },
        ...extra,
      };
}
