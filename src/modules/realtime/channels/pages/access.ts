import { Injectable, Logger, Optional } from '@nestjs/common';
import { AccessService, Role, Permission } from '@/modules/project/access';
import { DocstoreService } from '@/modules/pages/docstore';
import { PrismaService, isUuid } from '@/core';
import { RealtimeServiceUnavailableException } from '../../core/errors';
import {
  PAGES_REALTIME_DEFAULTS,
  PagesRealtimeConfigService,
  resolvePersonalSpaceId,
} from './config';
import type { WsAccessLevel } from './guard';

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
  private readonly cache = new Map<string, CachedAccessEntry>();

  constructor(
    private readonly accessService: AccessService,
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: PagesRealtimeConfigService,
    @Optional() private readonly docstoreService?: DocstoreService,
  ) {}

  private setCacheEntry(
    key: string,
    access: RealtimeProjectAccess,
    now: number,
  ): void {
    const accessCfg = this.config?.getAccessConfig?.();
    const maxEntries =
      accessCfg?.maxCacheEntries ??
      PAGES_REALTIME_DEFAULTS.access.maxCacheEntries;
    const ttlSeconds =
      accessCfg?.cacheTtlSeconds ??
      PAGES_REALTIME_DEFAULTS.access.cacheTtlSeconds;

    if (!this.cache.has(key) && this.cache.size >= maxEntries) {
      for (const [k, entry] of this.cache) {
        if (entry.expiresAt <= now) {
          this.cache.delete(k);
        }
      }
      if (this.cache.size >= maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.cache.delete(oldestKey);
        }
      }
    }
    this.cache.set(key, {
      access,
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  private getCacheKey(projectId: string, userId: string): string {
    return `${projectId}:${userId}`;
  }

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

  public async getProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<RealtimeProjectAccess> {
    projectId = resolvePersonalSpaceId(projectId, userId);

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

  public async resolveCanonicalSpaceAndPage(
    rawId: string,
    userId: string,
  ): Promise<{ spaceId: string; pageId?: string }> {
    if (!rawId || typeof rawId !== 'string') {
      return { spaceId: rawId };
    }
    const trimmed = resolvePersonalSpaceId(rawId.trim(), userId);
    if (!isUuid(trimmed)) {
      return { spaceId: trimmed };
    }
    if (userId && trimmed.toLowerCase() === userId.toLowerCase()) {
      return { spaceId: userId };
    }

    try {
      const page = this.prisma?.page?.findUnique
        ? await Promise.resolve(
            this.prisma.page.findUnique({
              where: { id: trimmed },
              select: { id: true, spaceId: true, deletedAt: true },
            }),
          ).catch(() => null)
        : null;
      if (page?.spaceId) {
        return { spaceId: page.spaceId, pageId: page.id };
      }

      const pageDoc = this.prisma?.pageDoc?.findUnique
        ? await Promise.resolve(
            this.prisma.pageDoc.findUnique({
              where: { id: trimmed },
              select: { id: true, spaceId: true, pageId: true },
            }),
          ).catch(() => null)
        : null;
      if (pageDoc?.spaceId) {
        return {
          spaceId: pageDoc.spaceId,
          pageId: pageDoc.pageId ?? undefined,
        };
      }
    } catch {
      // Fall back to raw trimmed UUID if lookup fails transiently
    }

    return { spaceId: trimmed };
  }

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

  public async validateDocInProject(
    projectId: string,
    docId: string,
    expectedPageId?: string,
  ): Promise<boolean> {
    if (!projectId || !docId || !isUuid(projectId) || !isUuid(docId)) {
      return false;
    }

    try {
      if (this.docstoreService) {
        const doc = await this.docstoreService.getDocById(docId);
        if (doc) {
          if (doc.deleted) {
            return false;
          }
          if (doc.projectId === projectId) {
            if (expectedPageId && doc.pageId && doc.pageId !== expectedPageId) {
              return false;
            }
            return true;
          }
          if (
            doc.projectId &&
            isUuid(doc.projectId) &&
            this.prisma.page?.findUnique
          ) {
            const page = await Promise.resolve(
              this.prisma.page.findUnique({
                where: { id: doc.projectId },
                select: { id: true, spaceId: true, deletedAt: true },
              }),
            ).catch(() => null);
            if (
              page &&
              !page.deletedAt &&
              (page.id === projectId || page.spaceId === projectId) &&
              (!expectedPageId || page.id === expectedPageId)
            ) {
              return true;
            }
          }
          if (!this.prisma?.pageDoc?.findUnique) {
            return false;
          }
        } else if (!this.prisma?.pageDoc?.findUnique) {
          return false;
        }
      }

      if (!this.prisma?.pageDoc?.findUnique) {
        return false;
      }

      const doc = await this.prisma.pageDoc.findUnique({
        where: { id: docId },
        select: { spaceId: true, pageId: true, deletedAt: true },
      });

      if (!doc || doc.deletedAt) {
        return false;
      }

      if (doc.spaceId === projectId) {
        if (expectedPageId && doc.pageId && doc.pageId !== expectedPageId) {
          return false;
        }
        return true;
      }

      if (doc.pageId === projectId) {
        return !expectedPageId || doc.pageId === expectedPageId;
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
            select: { id: true, spaceId: true, deletedAt: true },
          }),
        ).catch(() => null);
        if (
          page &&
          !page.deletedAt &&
          (page.id === projectId || page.spaceId === projectId) &&
          (!expectedPageId || page.id === expectedPageId)
        ) {
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
