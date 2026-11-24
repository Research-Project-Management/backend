import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/core';
import {
  UserIntegration,
  PageReferenceLink,
  PageGithubLink,
  Prisma,
} from '@prisma/client';
import { IntegrationProviderType } from './providers/integration-provider.interface';

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

  async assertUserPageAccess(
    userId: string,
    pageId: string,
    access: 'read' | 'write' | 'manage' = 'read',
  ): Promise<void> {
    if (!pageId || !userId) {
      throw new BadRequestException('Page ID and User ID are required.');
    }

    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: {
        id: true,
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
      return;
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

    if (access === 'manage' && member.role !== 'owner' && member.role !== 'coordinator') {
      throw new ForbiddenException(
        'Access denied: Only project owners or coordinators can manage repository links.',
      );
    }

    if (access === 'write' && member.role === 'reviewer') {
      throw new ForbiddenException(
        'Access denied: You do not have write access to this page.',
      );
    }
  }
}
