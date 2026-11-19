import { ForbiddenException } from '@nestjs/common';
import type { SpaceRecord } from '../types/access.type';

export function assertPersonalSpaceOwnership(
  space: SpaceRecord,
  userId: string,
  errorMessage = 'You do not have access to this workspace',
): void {
  if (
    space.type === 'personal' &&
    space.ownerUserId &&
    space.ownerUserId !== userId
  ) {
    throw new ForbiddenException(errorMessage);
  }
}

export function hasDirectFileOwnership(
  record: {
    createdById?: string | null;
    spaceId?: string | null;
    sharedWith?: Array<{ userId?: string }>;
  },
  userId: string,
): boolean {
  if (record.createdById === userId || record.spaceId === userId) {
    return true;
  }
  return Boolean(record.sharedWith && record.sharedWith.length > 0);
}

export function extractRagDocIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const val = (metadata as Record<string, unknown>).ragDocId;
  return typeof val === 'string' && val.trim() ? val.trim() : null;
}
