/**
 * git-bridge/git-bridge.repository.ts
 * Direct @Injectable() Prisma Repository for Manuscripts Git Bridge:
 * - UserSettings Git token storage & ProjectMember role resolution
 */

import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { IdentityFacade } from '@/modules/identity/identity.facade';
import { AccessService } from '@/modules/project/access';
import {
  ProjectRole,
  StoredGitToken,
  IGitAccessRepositoryPort,
  UserEditorGitConfig,
  GitRunResult,
} from './domain';
import { GitCliAdapter, EMPTY_TREE_SHA1 } from './adapters/git-cli.adapter';

export type { GitRunResult };
export { GitCliAdapter, EMPTY_TREE_SHA1 };

@Injectable()
export class GitBridgeRepository implements IGitAccessRepositoryPort {
  constructor(
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly identityFacade?: IdentityFacade,
    @Optional()
    private readonly accessService?: AccessService,
  ) {}

  async readConfig(userId: string): Promise<UserEditorGitConfig> {
    if (!this.prisma) {
      return { editorConfig: {}, tokens: [] };
    }
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { editorConfig: true },
    });
    const editorConfig = (row?.editorConfig as Record<string, unknown>) || {};
    const tokens: StoredGitToken[] = Array.isArray(editorConfig.gitTokens)
      ? (editorConfig.gitTokens as StoredGitToken[])
      : [];
    return { editorConfig, tokens };
  }

  async writeTokens(
    userId: string,
    editorConfig: Record<string, unknown>,
    tokens: StoredGitToken[],
  ): Promise<void> {
    if (!this.prisma) return;
    const next = {
      ...editorConfig,
      gitTokens: tokens,
    } as unknown as Prisma.InputJsonValue;
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, editorConfig: next },
      update: { editorConfig: next },
    });
  }

  async isActiveUser(userId: string): Promise<boolean> {
    if (this.identityFacade) {
      const session = await this.identityFacade
        .validateUser(userId)
        .catch(() => null);
      if (session) return true;
    }
    if (!this.prisma) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });
    return Boolean(user && !user.deletedAt);
  }

  async resolveProjectRole(
    projectId: string,
    userId: string,
  ): Promise<ProjectRole | null> {
    if (!projectId || !userId || !isUuid(projectId) || !isUuid(userId)) {
      return null;
    }
    if (projectId.toLowerCase() === userId.toLowerCase()) {
      return 'owner';
    }
    if (this.accessService) {
      const context = await this.accessService
        .getMemberAccessContext(projectId, userId)
        .catch(() => null);
      if (context?.role) {
        return context.role as ProjectRole;
      }
    }
    if (!this.prisma) return null;
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (member) return member.role;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { createdById: true },
    });
    if (project?.createdById === userId) return 'owner';

    if (this.prisma.space?.findUnique) {
      const space = await Promise.resolve(
        this.prisma.space.findUnique({
          where: { id: projectId },
          select: { ownerUserId: true, projectId: true },
        }),
      ).catch(() => null);
      if (space?.ownerUserId === userId) return 'owner';
      if (space?.projectId && isUuid(space.projectId)) {
        const spaceMember = await this.prisma.projectMember.findUnique({
          where: {
            projectId_userId: { projectId: space.projectId, userId },
          },
          select: { role: true },
        });
        if (spaceMember) return spaceMember.role;
      }
    }

    if (this.prisma.page?.findUnique) {
      const page = await Promise.resolve(
        this.prisma.page.findUnique({
          where: { id: projectId },
          select: { spaceId: true, createdById: true },
        }),
      ).catch(() => null);
      if (page?.spaceId === userId || page?.createdById === userId) {
        return 'owner';
      }
    }

    return null;
  }
}
