/**
 * git-bridge/git-bridge.repository.ts
 * BCNF Prisma Repository for `GitAccessToken`, `PageGitRepo`, `GitPushEvent`,
 * and Manuscript Space/Page RBAC resolution.
 */

import { Injectable, Optional } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { AccessService } from '@/modules/project/access';
import { ProjectRole } from './domain/policy';

export interface TokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly tokenHint: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
}

export interface RepoTarget {
  readonly repoId: string;
  readonly spaceId: string;
  readonly pageId?: string;
  readonly ownerId?: string | null;
}

export interface PushTransitionInput {
  readonly pageId: string;
  readonly pusherId?: string | null;
  readonly snapshotId?: string | null;
  readonly beforeOid: string | null;
  readonly afterOid: string;
  readonly rootTreeOid: string;
  readonly commitSubject: string | null;
  readonly addedCount: number;
  readonly modifiedCount: number;
  readonly deletedCount: number;
  readonly totalBytes: number;
}

@Injectable()
export class GitBridgeRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly identity?: IdentityFacade,
    @Optional() private readonly access?: AccessService,
  ) {}

  // ─── 1. GitAccessToken (BCNF: CK1 = {id}, CK2 = {tokenHash}) ────────────────

  public listActiveTokens(
    userId: string,
    now: Date = new Date(),
  ): Promise<TokenRecord[]> {
    return this.prisma.gitAccessToken.findMany({
      where: { userId, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async pruneUserExpired(
    userId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const res = await this.prisma.gitAccessToken.deleteMany({
      where: { userId, expiresAt: { lte: now } },
    });
    return res.count;
  }

  public async pruneAllExpired(now: Date = new Date()): Promise<number> {
    const res = await this.prisma.gitAccessToken.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return res.count;
  }

  public countActiveTokens(
    userId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return this.prisma.gitAccessToken.count({
      where: { userId, expiresAt: { gt: now } },
    });
  }

  public createToken(data: {
    userId: string;
    label: string;
    tokenHint: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<TokenRecord> {
    return this.prisma.gitAccessToken.create({ data });
  }

  public async deleteToken(
    userId: string,
    tokenId: string,
  ): Promise<TokenRecord | null> {
    if (!isUuid(tokenId)) return null;
    const found = await this.prisma.gitAccessToken.findFirst({
      where: { id: tokenId, userId },
    });
    if (!found) return null;
    await this.prisma.gitAccessToken.delete({ where: { id: found.id } });
    return found;
  }

  public findByHash(tokenHash: string): Promise<TokenRecord | null> {
    if (tokenHash.length !== 64) return Promise.resolve(null);
    return this.prisma.gitAccessToken.findUnique({ where: { tokenHash } });
  }

  public async touchToken(
    tokenId: string,
    usedAt: Date = new Date(),
  ): Promise<void> {
    await this.prisma.gitAccessToken
      .update({ where: { id: tokenId }, data: { lastUsedAt: usedAt } })
      .catch(() => undefined);
  }

  // ─── 2. PageGitRepo & GitPushEvent (BCNF State & Lineage) ───────────────────

  public async upsertRepoState(
    pageId: string,
    headCommitOid: string,
    rootTreeOid: string,
  ): Promise<void> {
    if (!isUuid(pageId)) return;
    const now = new Date();
    await this.prisma.pageGitRepo.upsert({
      where: { pageId },
      create: {
        pageId,
        headCommitOid,
        rootTreeOid,
        isMaterialized: true,
        lastAccessedAt: now,
      },
      update: {
        headCommitOid,
        rootTreeOid,
        isMaterialized: true,
        lastAccessedAt: now,
      },
    });
  }

  /**
   * Atomically updates `PageGitRepo` head/tree/gc counter and inserts `GitPushEvent`.
   * Returns updated `gcPushCount` for deterministic `git gc --auto` scheduling.
   */
  public async recordPushTransition(
    input: PushTransitionInput,
  ): Promise<number> {
    if (!isUuid(input.pageId)) return 0;
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const repoState = await tx.pageGitRepo.upsert({
        where: { pageId: input.pageId },
        create: {
          pageId: input.pageId,
          headCommitOid: input.afterOid,
          rootTreeOid: input.rootTreeOid,
          isMaterialized: true,
          gcPushCount: 1,
          lastAccessedAt: now,
        },
        update: {
          headCommitOid: input.afterOid,
          rootTreeOid: input.rootTreeOid,
          isMaterialized: true,
          gcPushCount: { increment: 1 },
          lastAccessedAt: now,
        },
        select: { gcPushCount: true },
      });

      await tx.gitPushEvent.upsert({
        where: {
          pageId_afterOid: {
            pageId: input.pageId,
            afterOid: input.afterOid,
          },
        },
        create: {
          pageId: input.pageId,
          pusherId: input.pusherId ?? null,
          snapshotId: input.snapshotId ?? null,
          beforeOid: input.beforeOid,
          afterOid: input.afterOid,
          commitSubject: input.commitSubject,
          addedCount: input.addedCount,
          modifiedCount: input.modifiedCount,
          deletedCount: input.deletedCount,
          totalBytes: input.totalBytes,
        },
        update: {
          snapshotId: input.snapshotId ?? undefined,
        },
      });

      return repoState.gcPushCount;
    });
  }

  public async resetGcPushCount(pageId: string): Promise<void> {
    if (!isUuid(pageId)) return;
    await this.prisma.pageGitRepo
      .update({
        where: { pageId },
        data: { gcPushCount: 0 },
      })
      .catch(() => undefined);
  }

  public async findIdleMaterializedPageIds(cutoff: Date): Promise<string[]> {
    const rows = await this.prisma.pageGitRepo.findMany({
      where: {
        isMaterialized: true,
        lastAccessedAt: { lt: cutoff },
      },
      select: { pageId: true },
    });
    return rows.map((r) => r.pageId);
  }

  public async markReposEvicted(pageIds: string[]): Promise<void> {
    const valid = pageIds.filter(isUuid);
    if (valid.length === 0) return;
    await this.prisma.pageGitRepo
      .updateMany({
        where: { pageId: { in: valid } },
        data: { isMaterialized: false },
      })
      .catch(() => undefined);
  }

  // ─── 3. Identity & Space/Page Role Resolution ───────────────────────────────

  public async isActiveUser(userId: string): Promise<boolean> {
    if (this.identity) {
      const session = await this.identity
        .validateUser(userId)
        .catch(() => null);
      if (session) return true;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, deletedAt: true },
    });
    return Boolean(user && !user.deletedAt && user.status !== 'suspended');
  }

  public async resolveRole(
    repoId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    if (!repoId || !userId || !isUuid(repoId) || !isUuid(userId)) return null;

    const page = await this.prisma.page.findUnique({
      where: { id: repoId },
      select: {
        spaceId: true,
        deletedAt: true,
        createdById: true,
        space: { select: { type: true, ownerUserId: true, projectId: true } },
      },
    });

    if (page) {
      if (page.deletedAt) return null;
      if (page.space.type === 'personal' || page.space.ownerUserId) {
        return page.space.ownerUserId === userId || page.spaceId === userId
          ? 'owner'
          : null;
      }
      if (page.space.projectId) {
        return this.lookupProjectRole(page.space.projectId, userId);
      }
      return page.spaceId === userId || page.createdById === userId
        ? 'owner'
        : null;
    }

    const space = await this.prisma.space.findUnique({
      where: { id: repoId },
      select: { ownerUserId: true, projectId: true },
    });
    if (space) {
      if (space.ownerUserId === userId) return 'owner';
      if (space.projectId) {
        return this.lookupProjectRole(space.projectId, userId);
      }
    }

    return null;
  }

  private async lookupProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    if (this.access) {
      const role = await this.access
        .getRole(projectId, userId)
        .catch(() => null);
      if (role) return role;
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (member) return member.role;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { createdById: true },
    });
    return project?.createdById === userId ? 'owner' : null;
  }

  public async resolveTarget(
    baseId: string,
    pageId?: string,
  ): Promise<RepoTarget> {
    if (!isUuid(baseId)) return { repoId: baseId, spaceId: baseId };

    if (pageId && isUuid(pageId)) {
      const page = await this.prisma.page.findFirst({
        where: { id: pageId, deletedAt: null },
        select: { id: true, spaceId: true, createdById: true },
      });
      if (page && (page.spaceId === baseId || page.id === baseId)) {
        return {
          repoId: page.id,
          spaceId: page.spaceId,
          pageId: page.id,
          ownerId: page.createdById,
        };
      }
    }

    const direct = await this.prisma.page.findUnique({
      where: { id: baseId },
      select: { id: true, spaceId: true, deletedAt: true, createdById: true },
    });
    if (direct && !direct.deletedAt) {
      return {
        repoId: direct.id,
        spaceId: direct.spaceId,
        pageId: direct.id,
        ownerId: direct.createdById,
      };
    }

    const primary = await this.prisma.page.findFirst({
      where: { spaceId: baseId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, spaceId: true, createdById: true },
    });
    if (primary) {
      return {
        repoId: primary.id,
        spaceId: primary.spaceId,
        pageId: primary.id,
        ownerId: primary.createdById,
      };
    }

    return { repoId: baseId, spaceId: baseId };
  }

  public async findSpacePageIds(spaceId: string): Promise<string[]> {
    if (!isUuid(spaceId)) return [];
    const rows = await this.prisma.page.findMany({
      where: { spaceId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
