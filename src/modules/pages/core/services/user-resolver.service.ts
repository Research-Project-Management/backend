/**
 * modules/pages/core/services/user-resolver.service.ts
 * Domain service resolving user display names and avatars from IdentityFacade or Prisma User + Profile records.
 */

import { Injectable, Optional } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { IdentityFacade } from '@/modules/identity/identity.facade';

export interface ResolvedPageUser {
  id: string;
  name: string;
  avatar?: string;
}

@Injectable()
export class UserResolverService {
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly identityFacade?: IdentityFacade,
  ) {}

  /** Resolves user display names and avatars via IdentityFacade (Modular Monolith) or Prisma fallback. */
  public async resolveUserNames(
    userIds: (string | null | undefined)[],
  ): Promise<Map<string, ResolvedPageUser>> {
    const result = new Map<string, ResolvedPageUser>();
    const validIds = Array.from(
      new Set(userIds.filter((id): id is string => isUuid(id))),
    );
    if (validIds.length === 0) return result;

    if (this.identityFacade) {
      await Promise.all(
        validIds.map(async (uid) => {
          try {
            const session = await this.identityFacade!.validateUser(uid);
            if (session) {
              result.set(uid, {
                id: uid,
                name:
                  session.name ||
                  session.email?.split('@')[0] ||
                  'Collaborator',
                avatar: session.avatar || '',
              });
            }
          } catch {
            // Fall through to prisma lookup if needed
          }
        }),
      );
      if (result.size === validIds.length) {
        return result;
      }
    }

    if (this.prisma?.user?.findMany) {
      try {
        const remainingIds = validIds.filter((id) => !result.has(id));
        const users = await this.prisma.user.findMany({
          where: { id: { in: remainingIds } },
          select: {
            id: true,
            email: true,
            profile: {
              select: { name: true, avatar: true },
            },
          },
        });
        for (const u of users) {
          const name =
            u.profile?.name || u.email?.split('@')[0] || 'Collaborator';
          const avatar = u.profile?.avatar || '';
          result.set(u.id, { id: u.id, name, avatar });
        }
      } catch {
        // Fallback silently to default Collaborator if user lookup fails
      }
    }

    return result;
  }
}
