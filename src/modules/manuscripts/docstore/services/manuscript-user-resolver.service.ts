/**
 * modules/manuscripts/docstore/services/manuscript-user-resolver.service.ts
 * Domain service resolving user display names and avatars from User + Profile records.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';

const isUuid = (val?: string | null): val is string =>
  typeof val === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

export interface ResolvedManuscriptUser {
  id: string;
  name: string;
  avatar?: string;
}

@Injectable()
export class ManuscriptUserResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resolves user display names and avatars from Prisma User + Profile records. */
  public async resolveUserNames(
    userIds: (string | null | undefined)[],
  ): Promise<Map<string, ResolvedManuscriptUser>> {
    const result = new Map<string, ResolvedManuscriptUser>();
    const validIds = Array.from(
      new Set(userIds.filter((id): id is string => isUuid(id))),
    );
    if (validIds.length === 0) return result;

    try {
      const users = await this.prisma.user.findMany({
        where: { id: { in: validIds } },
        include: { profile: true },
      });
      for (const u of users) {
        const profileObj = u.profile as
          | {
              name?: string | null;
              avatarUrl?: string | null;
              avatar?: string | null;
            }
          | null
          | undefined;
        const name =
          profileObj?.name || u.email?.split('@')[0] || 'Collaborator';
        const avatar = profileObj?.avatarUrl || profileObj?.avatar || '';
        result.set(u.id, { id: u.id, name, avatar });
      }
    } catch {
      // Fallback silently to default Collaborator if user lookup fails
    }

    return result;
  }
}
