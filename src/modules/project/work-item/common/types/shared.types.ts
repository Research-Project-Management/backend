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

export function buildProjectIdOrIdentifierWhere(
  projectIdOrIdentifier: string,
  extra: Record<string, unknown> = { deletedAt: null },
): Prisma.ProjectWhereInput {
  return isUuid(projectIdOrIdentifier)
    ? { id: projectIdOrIdentifier, ...extra }
    : {
        identifier: { equals: projectIdOrIdentifier, mode: 'insensitive' },
        ...extra,
      };
}

export function normalizeStringIds(rawIds: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(rawIds) ? rawIds : [])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).sort();
}

export async function resolveCanonicalProjectId(
  prisma: {
    project?: {
      findFirst?: (args: {
        where: Prisma.ProjectWhereInput;
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  projectIdOrIdentifier: string,
): Promise<string | null> {
  if (!projectIdOrIdentifier) return null;
  if (isUuid(projectIdOrIdentifier)) {
    return projectIdOrIdentifier;
  }
  if (!prisma.project?.findFirst) return null;
  try {
    const project = await prisma.project.findFirst({
      where: buildProjectIdOrIdentifierWhere(projectIdOrIdentifier),
      select: { id: true },
    });
    return project?.id ?? null;
  } catch {
    return null;
  }
}

export async function resolveWorkItemUuid(
  prisma: {
    workItem?: {
      findFirst?: (args: {
        where: Prisma.WorkItemWhereInput;
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  idOrIdentifier: string,
): Promise<string | null> {
  if (!idOrIdentifier) return null;
  if (isUuid(idOrIdentifier)) {
    return idOrIdentifier;
  }
  if (!prisma.workItem?.findFirst) return null;
  try {
    const item = await prisma.workItem.findFirst({
      where: buildWorkItemIdOrIdentifierWhere(idOrIdentifier),
      select: { id: true },
    });
    return item?.id ?? null;
  } catch {
    return null;
  }
}
