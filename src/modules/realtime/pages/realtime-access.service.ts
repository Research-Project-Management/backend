import { Injectable, Logger, Optional } from '@nestjs/common';
import { AccessService, Role, Permission } from '@/modules/project/access';
import { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import { PrismaService, isUuid } from '@/core';
import { RealtimeConfigService } from '../core/realtime.config';
import { WsAccessLevel } from '../core/ws-access.decorator';
import { RealtimeServiceUnavailableException } from '../core/ws-errors';

export type RealtimeAccessDecision = 'allowed' | 'denied' | 'unavailable';

export interface RealtimeProjectAccess {
  canRead: boolean;
  canWrite: boolean;
  isAdmin?: boolean;
  role: Role | 'none';
  decision: RealtimeAccessDecision;
}

interface CachedAccessEntry {
  access: RealtimeProjectAccess;
  expiresAt: number;
}

@Injectable()
export class RealtimeAccessService {
  private readonly logger = new Logger(RealtimeAccessService.name);
  private static readonly MAX_CACHE_ENTRIES = 2000;
  private readonly cache = new Map<string, CachedAccessEntry>();

  constructor(
    private readonly accessService: AccessService,
    private readonly prisma: PrismaService,
    private readonly config: RealtimeConfigService,
    @Optional() private readonly docstoreService?: DocstoreService,
  ) {}

  private setCacheEntry(
    key: string,
    access: RealtimeProjectAccess,
    now: number,
  ): void {
    if (
      !this.cache.has(key) &&
      this.cache.size >= RealtimeAccessService.MAX_CACHE_ENTRIES
    ) {
      for (const [k, entry] of this.cache) {
        if (entry.expiresAt <= now) {
          this.cache.delete(k);
        }
      }
      if (this.cache.size >= RealtimeAccessService.MAX_CACHE_ENTRIES) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
    }
    this.cache.set(key, {
      access,
      expiresAt: now + this.config.getAuthCacheTtlSeconds() * 1000,
    });
  }

  private getCacheKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

  /**
   * Evicts cached access decisions for a project, optionally scoped to a single user.
   * Invoked upon receiving access revocation or role modification events (R-07).
   */
  public evictCache(projectId: string, userId?: string): void {
    if (userId) {
      this.cache.delete(this.getCacheKey(projectId, userId));
    } else {
      const prefix = `${projectId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Resolves the user's realtime access permissions for a given project, leveraging
   * a short-lived in-memory decision cache (default 30s) and failing closed on outages (R-04).
   */
  public async getProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<RealtimeProjectAccess> {
    if (
      typeof projectId === 'string' &&
      ['personal', 'me', 'user', 'default'].includes(
        projectId.trim().toLowerCase(),
      ) &&
      userId
    ) {
      projectId = userId;
    }

    if (!projectId || !userId || !isUuid(projectId) || !isUuid(userId)) {
      return {
        canRead: false,
        canWrite: false,
        role: 'none',
        decision: 'denied',
      };
    }

    const cacheKey = this.getCacheKey(projectId, userId);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.access;
    }

    if (projectId.toLowerCase() === userId.toLowerCase()) {
      const ownerResult: RealtimeProjectAccess = {
        canRead: true,
        canWrite: true,
        isAdmin: true,
        role: Role.OWNER,
        decision: 'allowed',
      };
      this.setCacheEntry(cacheKey, ownerResult, now);
      return ownerResult;
    }

    try {
      let context = await this.accessService.getMemberAccessContext(
        projectId,
        userId,
      );

      if (!context) {
        const [space, page, pageDoc] = await Promise.all([
          this.prisma.space?.findUnique
            ? Promise.resolve(
                this.prisma.space.findUnique({
                  where: { id: projectId },
                  select: { type: true, ownerUserId: true, projectId: true },
                }),
              ).catch(() => null)
            : Promise.resolve(null),
          this.prisma.page?.findUnique
            ? Promise.resolve(
                this.prisma.page.findUnique({
                  where: { id: projectId },
                  select: {
                    spaceId: true,
                    createdById: true,
                    deletedAt: true,
                  },
                }),
              ).catch(() => null)
            : Promise.resolve(null),
          this.prisma.pageDoc?.findUnique
            ? Promise.resolve(
                this.prisma.pageDoc.findUnique({
                  where: { id: projectId },
                  select: { spaceId: true, deletedAt: true },
                }),
              ).catch(() => null)
            : Promise.resolve(null),
        ]);

        const grantOwner = (): RealtimeProjectAccess => {
          const ownerAccess: RealtimeProjectAccess = {
            canRead: true,
            canWrite: true,
            isAdmin: true,
            role: Role.OWNER,
            decision: 'allowed',
          };
          this.setCacheEntry(cacheKey, ownerAccess, now);
          return ownerAccess;
        };

        if (space?.ownerUserId === userId) {
          return grantOwner();
        }
        if (
          space?.projectId &&
          isUuid(space.projectId) &&
          space.projectId !== projectId
        ) {
          context = await this.accessService.getMemberAccessContext(
            space.projectId,
            userId,
          );
        }

        if (!context && page && !page.deletedAt) {
          if (page.spaceId === userId || page.createdById === userId) {
            return grantOwner();
          }
          if (
            page.spaceId &&
            isUuid(page.spaceId) &&
            page.spaceId !== projectId
          ) {
            context = await this.accessService.getMemberAccessContext(
              page.spaceId,
              userId,
            );
            if (!context && this.prisma.space?.findUnique) {
              const pageSpace = await Promise.resolve(
                this.prisma.space.findUnique({
                  where: { id: page.spaceId },
                  select: { ownerUserId: true },
                }),
              ).catch(() => null);
              if (pageSpace?.ownerUserId === userId) {
                return grantOwner();
              }
            }
          }
        }

        if (!context && pageDoc && !pageDoc.deletedAt) {
          if (pageDoc.spaceId === userId) {
            return grantOwner();
          }
          if (
            pageDoc.spaceId &&
            isUuid(pageDoc.spaceId) &&
            pageDoc.spaceId !== projectId
          ) {
            const parentAccess = await this.getProjectAccess(
              pageDoc.spaceId,
              userId,
            );
            this.setCacheEntry(cacheKey, parentAccess, now);
            return parentAccess;
          }
        }
      }

      if (!context) {
        const deniedResult: RealtimeProjectAccess = {
          canRead: false,
          canWrite: false,
          role: 'none',
          decision: 'denied',
        };
        this.setCacheEntry(cacheKey, deniedResult, now);
        return deniedResult;
      }

      const canRead =
        context.effectivePermissions.includes(Permission.DOCUMENT_READ) ||
        context.effectivePermissions.includes(Permission.DOCUMENT_VIEW);

      const canWrite =
        context.effectivePermissions.includes(Permission.DOCUMENT_UPDATE) ||
        context.effectivePermissions.includes(Permission.DOCUMENT_EDIT);

      const accessResult: RealtimeProjectAccess = {
        canRead,
        canWrite,
        isAdmin: context.role === Role.OWNER,
        role: context.role,
        decision: 'allowed',
      };

      this.setCacheEntry(cacheKey, accessResult, now);

      return accessResult;
    } catch (err: unknown) {
      this.logger.error(
        `Failed to resolve member access context for user ${userId} in project ${projectId}: ${(err as Error)?.message}`,
      );
      return {
        canRead: false,
        canWrite: false,
        role: 'none',
        decision: 'unavailable',
      };
    }
  }

  /**
   * Checks whether a user satisfies a required WsAccessLevel for a project.
   */
  public async checkAccess(
    projectId: string,
    userId: string,
    requiredLevel: WsAccessLevel,
  ): Promise<RealtimeAccessDecision> {
    if (requiredLevel === 'none') {
      return 'allowed';
    }

    const access = await this.getProjectAccess(projectId, userId);

    if (access.decision === 'unavailable') {
      return 'unavailable';
    }

    if (access.decision === 'denied' || access.role === 'none') {
      return 'denied';
    }

    if (requiredLevel === 'member') {
      return 'allowed';
    }

    if (requiredLevel === 'read') {
      return access.canRead ? 'allowed' : 'denied';
    }

    if (requiredLevel === 'write') {
      return access.canWrite ? 'allowed' : 'denied';
    }

    return 'denied';
  }

  /**
   * Validates that the requested document actually belongs to the specified project.
   * Prevents cross-project document access and IDOR (US2 / RT-04).
   */
  public async validateDocInProject(
    projectId: string,
    docId: string,
  ): Promise<boolean> {
    if (!projectId || !docId || !isUuid(projectId) || !isUuid(docId)) {
      return false;
    }

    // Root project virtual doc check
    if (docId === projectId) {
      return true;
    }

    try {
      if (this.docstoreService) {
        const doc = await this.docstoreService.getDocById(docId);
        if (doc && doc.projectId === projectId) {
          return true;
        }
        if (
          doc &&
          doc.projectId &&
          isUuid(doc.projectId) &&
          this.prisma.page?.findUnique
        ) {
          const page = await Promise.resolve(
            this.prisma.page.findUnique({
              where: { id: doc.projectId },
              select: { id: true, spaceId: true },
            }),
          ).catch(() => null);
          if (page && (page.id === projectId || page.spaceId === projectId)) {
            return true;
          }
        }
        if (!doc && !this.prisma?.pageDoc?.findUnique) {
          return false;
        }
        if (doc && !this.prisma?.pageDoc?.findUnique) {
          return false;
        }
      }

      if (!this.prisma?.pageDoc?.findUnique) {
        return false;
      }

      const doc = await this.prisma.pageDoc.findUnique({
        where: { id: docId },
        select: { spaceId: true, pageId: true },
      });

      if (!doc) {
        if (this.prisma.page?.findUnique) {
          const page = await Promise.resolve(
            this.prisma.page.findUnique({
              where: { id: docId },
              select: { id: true, spaceId: true },
            }),
          ).catch(() => null);
          if (page && (page.id === projectId || page.spaceId === projectId)) {
            return true;
          }
        }
        return false;
      }

      if (doc.spaceId === projectId || doc.pageId === projectId) {
        return true;
      }

      const candidatePageId = doc.pageId || doc.spaceId;
      if (
        candidatePageId &&
        isUuid(candidatePageId) &&
        this.prisma.page?.findUnique
      ) {
        const page = await Promise.resolve(
          this.prisma.page.findUnique({
            where: { id: candidatePageId },
            select: { id: true, spaceId: true },
          }),
        ).catch(() => null);
        if (page && (page.id === projectId || page.spaceId === projectId)) {
          return true;
        }
      }

      return false;
    } catch (err: unknown) {
      this.logger.error(
        `Database outage while verifying doc ownership for doc ${docId} in project ${projectId}: ${(err as Error)?.message}`,
      );
      throw new RealtimeServiceUnavailableException(
        'Service temporarily unavailable: database error verifying document ownership',
      );
    }
  }
}
