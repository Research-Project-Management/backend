/**
 * modules/pages/track-changes/services/review-notification.dispatcher.ts
 * Space/collaborator context resolver and non-blocking review notification dispatcher.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { UserResolverService } from '@/modules/pages/core/services/user-resolver.service';
import { ScopeRepository } from '@/modules/pages/docstore/repositories/scope.repository';
import { PagesNotificationsService } from '@/modules/notifications/pages/pages-notifications.service';
import { ReviewScopeRepository } from '../repositories/review-scope.repository';

export interface SpaceNotificationContext {
  spaceId: string;
  projectId: string | null;
  projectName?: string;
  pageId?: string | null;
  isPersonalSpace: boolean;
  collaboratorMap: Record<string, string>;
  fallbackOwnerId?: string | null;
}

@Injectable()
export class ReviewNotificationDispatcher {
  private readonly logger = new Logger(ReviewNotificationDispatcher.name);

  constructor(
    private readonly userResolver: UserResolverService,
    @Optional() private readonly reviewScopeRepo?: ReviewScopeRepository,
    @Optional() private readonly pageScopeRepo?: ScopeRepository,
    @Optional()
    private readonly pagesNotifications?: PagesNotificationsService,
  ) {}

  public get notificationsClient(): PagesNotificationsService | undefined {
    return this.pagesNotifications;
  }

  public async resolveSpaceNotificationContext(
    spaceOrProjectId: string,
    pageIdHint?: string | null,
    docIdHint?: string | null,
  ): Promise<SpaceNotificationContext> {
    const collaboratorMap: Record<string, string> = {};
    const addCollaboratorEntries = (
      id: string,
      name?: string | null,
      email?: string | null,
    ) => {
      if (!id) return;
      if (email) {
        const lowerEmail = email.toLowerCase();
        collaboratorMap[lowerEmail] = id;
        const localPart = lowerEmail.split('@')[0];
        if (localPart) collaboratorMap[localPart] = id;
      }
      if (name) {
        const lowerName = name.toLowerCase().trim();
        collaboratorMap[lowerName] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '')] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '_')] = id;
        collaboratorMap[lowerName.replace(/\s+/g, '.')] = id;
      }
    };

    const prisma =
      typeof this.reviewScopeRepo?.getPrisma === 'function'
        ? this.reviewScopeRepo.getPrisma()
        : typeof this.pageScopeRepo?.getPrisma === 'function'
          ? this.pageScopeRepo.getPrisma()
          : undefined;

    let spaceId = spaceOrProjectId;
    let projectId: string | null = spaceOrProjectId;
    let projectName: string | undefined;
    let isPersonalSpace = false;
    let fallbackOwnerId: string | null = null;
    let canonicalPageId = pageIdHint ?? null;

    if (prisma) {
      if (!canonicalPageId && docIdHint) {
        const doc = await Promise.resolve(
          prisma.pageDoc?.findFirst?.({
            where: { id: docIdHint },
            select: { pageId: true },
          }),
        ).catch(() => null);
        if (doc?.pageId) canonicalPageId = doc.pageId;
      }

      const space = await Promise.resolve(
        prisma.space?.findFirst?.({
          where: {
            OR: [{ id: spaceOrProjectId }, { projectId: spaceOrProjectId }],
          },
          select: {
            id: true,
            type: true,
            ownerUserId: true,
            projectId: true,
          },
        }),
      ).catch(() => null);

      if (space) {
        spaceId = space.id;
        isPersonalSpace = space.type === 'personal';
        projectId = isPersonalSpace ? null : (space.projectId ?? null);
        if (isPersonalSpace && space.ownerUserId) {
          fallbackOwnerId = space.ownerUserId;
          const [owner, ownerNames] = await Promise.all([
            Promise.resolve(
              prisma.user?.findUnique?.({
                where: { id: space.ownerUserId },
                select: { id: true, email: true },
              }),
            ).catch(() => null),
            this.userResolver
              .resolveUserNames([space.ownerUserId])
              .catch(() => new Map<string, { id: string; name: string }>()),
          ]);
          const ownerId = owner?.id || space.ownerUserId;
          addCollaboratorEntries(
            ownerId,
            ownerNames.get(ownerId)?.name,
            owner?.email,
          );
        }
      }

      const lookupProjectId = projectId;
      if (lookupProjectId) {
        const project = await Promise.resolve(
          prisma.project?.findFirst?.({
            where: { id: lookupProjectId, deletedAt: null },
            include: {
              members: {
                select: {
                  userId: true,
                  user: { select: { id: true, email: true } },
                },
              },
            },
          }),
        ).catch(() => null);
        if (project) {
          projectName = project.name;
          fallbackOwnerId = project.createdById;
          const memberIds = [
            project.createdById,
            ...(project.members || []).map((m) => m.userId),
          ];
          const [resolvedNames, ownerUser] = await Promise.all([
            this.userResolver
              .resolveUserNames(memberIds)
              .catch(() => new Map<string, { id: string; name: string }>()),
            Promise.resolve(
              prisma.user?.findUnique?.({
                where: { id: project.createdById },
                select: { id: true, email: true },
              }),
            ).catch(() => null),
          ]);
          addCollaboratorEntries(
            project.createdById,
            resolvedNames.get(project.createdById)?.name,
            ownerUser?.email,
          );
          for (const m of project.members || []) {
            addCollaboratorEntries(
              m.userId,
              resolvedNames.get(m.userId)?.name,
              m.user?.email,
            );
          }
        }
      }
    }

    return {
      spaceId,
      projectId,
      projectName,
      pageId: canonicalPageId,
      isPersonalSpace,
      collaboratorMap,
      fallbackOwnerId,
    };
  }

  public async dispatchReviewNotificationSafe(
    label: string,
    fn: (notifications: PagesNotificationsService) => Promise<unknown>,
  ): Promise<void> {
    if (!this.pagesNotifications) return;
    try {
      await fn(this.pagesNotifications);
    } catch (err) {
      this.logger.warn(
        `Non-blocking notification dispatch (${label}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
