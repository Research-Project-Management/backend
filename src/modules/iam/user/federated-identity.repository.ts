import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { AuthProvider, Prisma, User } from '@prisma/client';
import { IFederatedIdentityRepository } from '../types/iam-repository.interface';

@Injectable()
export class FederatedIdentityRepository implements IFederatedIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProviderSubject(
    provider: AuthProvider,
    subjectId: string,
  ): Promise<{
    id: string;
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email: string | null;
    profileData: unknown;
    user: User;
  } | null> {
    return this.prisma.federatedIdentity.findUnique({
      where: {
        provider_providerSubjectId: {
          provider,
          providerSubjectId: subjectId,
        },
      },
      include: {
        user: true,
      },
    });
  }

  async findByUserId(userId: string) {
    return this.prisma.federatedIdentity.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        provider: true,
        providerSubjectId: true,
        email: true,
      },
    });
  }

  async linkIdentity(data: {
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email?: string;
    profileData?: Record<string, unknown>;
  }) {
    return this.prisma.federatedIdentity.upsert({
      where: {
        provider_providerSubjectId: {
          provider: data.provider,
          providerSubjectId: data.providerSubjectId,
        },
      },
      create: {
        userId: data.userId,
        provider: data.provider,
        providerSubjectId: data.providerSubjectId,
        email: data.email ?? null,
        profileData:
          (data.profileData as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
      update: {
        userId: data.userId,
        email: data.email ?? null,
        profileData: (data.profileData as Prisma.InputJsonValue) ?? undefined,
      },
    });
  }

  async unlinkIdentity(userId: string, provider: AuthProvider): Promise<void> {
    await this.prisma.federatedIdentity.deleteMany({
      where: {
        userId,
        provider,
      },
    });
  }
}
