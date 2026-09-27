import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { UserIntegration, ProjectIntegrationLink } from '@prisma/client';
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
          provider: provider as any,
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
    return this.prisma.userIntegration.upsert({
      where: {
        userId_provider: {
          userId: data.userId,
          provider: data.provider as any,
        },
      },
      update: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        providerUserId: data.providerUserId,
        accountName: data.accountName,
        accountEmail: data.accountEmail,
        metadata: data.metadata as any,
        status: 'connected',
        authFailedAt: null,
        updatedAt: new Date(),
      },
      create: {
        userId: data.userId,
        provider: data.provider as any,
        status: 'connected',
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        providerUserId: data.providerUserId,
        accountName: data.accountName,
        accountEmail: data.accountEmail,
        metadata: data.metadata as any,
      },
    });
  }

  async markAuthFailed(userId: string, provider: IntegrationProviderType): Promise<void> {
    await this.prisma.userIntegration.updateMany({
      where: {
        userId,
        provider: provider as any,
      },
      data: {
        status: 'error',
        authFailedAt: new Date(),
      },
    });
  }

  async deleteConnection(userId: string, provider: IntegrationProviderType): Promise<void> {
    await this.prisma.userIntegration.deleteMany({
      where: {
        userId,
        provider: provider as any,
      },
    });
  }

  async upsertProjectLink(data: {
    projectId: string;
    userIntegrationId: string;
    collectionId: string;
    collectionName: string;
    targetBibFile?: string;
  }): Promise<ProjectIntegrationLink> {
    return this.prisma.projectIntegrationLink.upsert({
      where: {
        projectId_userIntegrationId_collectionId: {
          projectId: data.projectId,
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
        projectId: data.projectId,
        userIntegrationId: data.userIntegrationId,
        collectionId: data.collectionId,
        collectionName: data.collectionName,
        targetBibFile: data.targetBibFile || 'references.bib',
      },
    });
  }

  async updateProjectLinkLastSynced(linkId: string): Promise<void> {
    await this.prisma.projectIntegrationLink.update({
      where: { id: linkId },
      data: { lastSyncedAt: new Date() },
    });
  }

  async findProjectLink(
    projectId: string,
    userIntegrationId: string,
  ): Promise<ProjectIntegrationLink | null> {
    return this.prisma.projectIntegrationLink.findFirst({
      where: {
        projectId,
        userIntegrationId,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}

