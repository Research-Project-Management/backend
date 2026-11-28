import * as crypto from 'node:crypto';
import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import {
  UserIntegration,
  PageReferenceLink,
  PageGithubLink,
  Prisma,
} from '@prisma/client';
import { IntegrationProviderType } from './providers/integration-provider.interface';

const PERSONAL_SPACE_ALIASES = new Set([
  '',
  'personal',
  'me',
  'user',
  'default',
  'global',
]);

@Injectable()
export class IntegrationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findConnection(
    userId: string,
    provider: IntegrationProviderType,
  ): Promise<UserIntegration | null> {
    return this.prisma.userIntegration.findUnique({
      where: {
        userId_provider: {
          userId,
          provider,
        },
      },
    });
  }

  async findAllUserConnections(userId: string): Promise<UserIntegration[]> {
    return this.prisma.userIntegration.findMany({
      where: { userId },
      orderBy: { connectedAt: 'desc' },
    });
  }

  async upsertConnection(data: {
    userId: string;
    provider: IntegrationProviderType;
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    providerUserId: string;
    accountName?: string | null;
    accountEmail?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<UserIntegration> {
    const metadataValue = (data.metadata as Prisma.InputJsonValue) ?? undefined;

    return this.prisma.userIntegration.upsert({
      where: {
        userId_provider: {
          userId: data.userId,
          provider: data.provider,
        },
      },
      update: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        providerUserId: data.providerUserId,
        accountName: data.accountName,
        accountEmail: data.accountEmail,
        metadata: metadataValue,
        status: 'connected',
        authFailedAt: null,
        updatedAt: new Date(),
      },
      create: {
        userId: data.userId,
        provider: data.provider,
        status: 'connected',
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        providerUserId: data.providerUserId,
        accountName: data.accountName,
        accountEmail: data.accountEmail,
        metadata: metadataValue,
      },
    });
  }

  async markAuthFailed(
    userId: string,
    provider: IntegrationProviderType,
  ): Promise<void> {
    await this.prisma.userIntegration.updateMany({
      where: {
        userId,
        provider,
      },
      data: {
        status: 'error',
        authFailedAt: new Date(),
      },
    });
  }

  async deleteConnection(
    userId: string,
    provider: IntegrationProviderType,
  ): Promise<void> {
    await this.prisma.userIntegration.deleteMany({
      where: {
        userId,
        provider,
      },
    });
  }

  async upsertReferenceLink(data: {
    pageId: string;
    userIntegrationId: string;
    collectionId: string;
    collectionName: string;
    targetBibFile?: string;
  }): Promise<PageReferenceLink> {
    return this.prisma.pageReferenceLink.upsert({
      where: {
        pageId_userIntegrationId_collectionId: {
          pageId: data.pageId,
          userIntegrationId: data.userIntegrationId,
          collectionId: data.collectionId,
        },
      },
      update: {
        collectionName: data.collectionName,
        targetBibFile: data.targetBibFile || 'references.bib',
        updatedAt: new Date(),
      },
      create: {
        pageId: data.pageId,
        userIntegrationId: data.userIntegrationId,
        collectionId: data.collectionId,
        collectionName: data.collectionName,
        targetBibFile: data.targetBibFile || 'references.bib',
      },
    });
  }

  async updateReferenceLinkLastSynced(linkId: string): Promise<void> {
    await this.prisma.pageReferenceLink.update({
      where: { id: linkId },
      data: { lastSyncedAt: new Date() },
    });
  }

  async upsertGithubLink(data: {
    pageId: string;
    userIntegrationId: string;
    repoFullName: string;
    branch?: string;
  }): Promise<PageGithubLink> {
    return this.prisma.pageGithubLink.upsert({
      where: { pageId: data.pageId },
      update: {
        userIntegrationId: data.userIntegrationId,
        repoFullName: data.repoFullName,
        branch: data.branch || 'main',
        updatedAt: new Date(),
      },
      create: {
        pageId: data.pageId,
        userIntegrationId: data.userIntegrationId,
        repoFullName: data.repoFullName,
        branch: data.branch || 'main',
      },
    });
  }

  async findGithubLink(
    pageId: string,
    userIntegrationId?: string,
  ): Promise<PageGithubLink | null> {
    return this.prisma.pageGithubLink.findFirst({
      where: {
        pageId,
        ...(userIntegrationId ? { userIntegrationId } : {}),
      },
    });
  }

  async updateGithubLinkLastSynced(linkId: string): Promise<void> {
    await this.prisma.pageGithubLink.update({
      where: { id: linkId },
      data: { lastSyncedAt: new Date() },
    });
  }

  async findActivePageById(
    pageId: string,
  ): Promise<{ id: string; spaceId: string; title: string } | null> {
    if (!pageId || !isUuid(pageId)) return null;
    return this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: { id: true, spaceId: true, title: true },
    });
  }

  async requireAuthorizedPage(
    userId: string,
    pageId: string,
    access: 'read' | 'write' | 'manage' = 'read',
  ): Promise<{ id: string; spaceId: string; title: string }> {
    if (!pageId || !userId) {
      throw new BadRequestException('Page ID and User ID are required.');
    }
    if (!isUuid(pageId)) {
      throw new NotFoundException('Page not found.');
    }

    const page = await this.prisma.page.findFirst({
      where: { id: pageId, deletedAt: null },
      select: {
        id: true,
        spaceId: true,
        title: true,
        deletedAt: true,
        space: {
          select: {
            type: true,
            ownerUserId: true,
            projectId: true,
          },
        },
      },
    });

    if (!page || page.deletedAt) {
      throw new NotFoundException('Page not found.');
    }

    if (page.space.type === 'personal') {
      if (page.space.ownerUserId !== userId) {
        throw new ForbiddenException(
          'Access denied: You do not own this personal page.',
        );
      }
      return { id: page.id, spaceId: page.spaceId, title: page.title };
    }

    if (!page.space.projectId) {
      throw new ForbiddenException('Access denied: Invalid page space.');
    }

    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: page.space.projectId,
          userId,
        },
      },
    });

    if (!member) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project.',
      );
    }

    if (
      access === 'manage' &&
      member.role !== 'owner' &&
      member.role !== 'coordinator'
    ) {
      throw new ForbiddenException(
        'Access denied: Only project owners or coordinators can manage repository links.',
      );
    }

    if (access === 'write' && member.role === 'reviewer') {
      throw new ForbiddenException(
        'Access denied: You do not have write access to this page.',
      );
    }

    return { id: page.id, spaceId: page.spaceId, title: page.title };
  }

  async assertUserPageAccess(
    userId: string,
    pageId: string,
    access: 'read' | 'write' | 'manage' = 'read',
  ): Promise<void> {
    await this.requireAuthorizedPage(userId, pageId, access);
  }

  async resolveAndAuthorizeSpace(
    userId: string,
    rawSpaceId?: string | null,
    access: 'read' | 'write' | 'manage' = 'write',
  ): Promise<{ spaceId: string; isPersonal: boolean }> {
    if (!userId || !isUuid(userId)) {
      throw new BadRequestException('Valid User ID is required.');
    }

    const trimmed = (rawSpaceId ?? '').trim();
    if (
      PERSONAL_SPACE_ALIASES.has(trimmed.toLowerCase()) ||
      trimmed.toLowerCase() === userId.toLowerCase()
    ) {
      await this.prisma.space.upsert({
        where: { id: userId },
        create: {
          id: userId,
          type: 'personal',
          ownerUserId: userId,
        },
        update: {},
      });
      return { spaceId: userId, isPersonal: true };
    }

    const [space, project] = await Promise.all([
      isUuid(trimmed)
        ? this.prisma.space.findUnique({
            where: { id: trimmed },
            select: {
              id: true,
              type: true,
              ownerUserId: true,
              projectId: true,
            },
          })
        : Promise.resolve(null),
      isUuid(trimmed)
        ? this.prisma.project.findFirst({
            where: { id: trimmed, deletedAt: null },
            select: { id: true },
          })
        : this.prisma.project.findFirst({
            where: {
              identifier: { equals: trimmed, mode: 'insensitive' },
              deletedAt: null,
            },
            select: { id: true },
          }),
    ]);

    if (space?.type === 'personal') {
      if (space.ownerUserId !== userId) {
        throw new ForbiddenException(
          'Access denied: You do not own this personal space.',
        );
      }
      return { spaceId: space.id, isPersonal: true };
    }

    const projectId = space?.projectId || project?.id;
    if (!projectId) {
      throw new NotFoundException('Target space or project not found.');
    }

    const member = await this.prisma.projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId,
          userId,
        },
      },
    });

    if (!member) {
      throw new ForbiddenException(
        'Access denied: You are not a member of this project.',
      );
    }

    if (
      access === 'manage' &&
      member.role !== 'owner' &&
      member.role !== 'coordinator'
    ) {
      throw new ForbiddenException(
        'Access denied: Only project owners or coordinators can manage repository links.',
      );
    }

    if (access === 'write' && member.role === 'reviewer') {
      throw new ForbiddenException(
        'Access denied: Contributor or higher role is required.',
      );
    }

    const canonicalSpaceId = space?.id || projectId;
    if (!space) {
      await this.prisma.space.upsert({
        where: { id: canonicalSpaceId },
        create: {
          id: canonicalSpaceId,
          type: 'project',
          projectId,
        },
        update: {},
      });
    }

    return { spaceId: canonicalSpaceId, isPersonal: false };
  }

  async createPageInSpace(params: {
    id?: string;
    spaceId: string;
    title: string;
    createdById: string;
  }): Promise<{ id: string; spaceId: string; title: string }> {
    const pageId = params.id ?? crypto.randomUUID();
    const created = await this.prisma.page.create({
      data: {
        id: pageId,
        spaceId: params.spaceId,
        rootDocId: null,
        title: (params.title || 'Untitled').slice(0, 500),
        status: 'draft',
        compiler: 'pdflatex',
        texlive: '2025',
        spellLang: 'en_US',
        createdById: isUuid(params.createdById) ? params.createdById : null,
      },
      select: {
        id: true,
        spaceId: true,
        title: true,
      },
    });
    return created;
  }
}
