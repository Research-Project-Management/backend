import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, User } from '@prisma/client';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async findUserById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findUserByOAuth(
    providerField: 'googleId' | 'githubId',
    profileId: string,
    email?: string,
  ): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { [providerField]: profileId },
          ...(email ? [{ email: email.toLowerCase() }] : []),
        ],
      },
    });
  }

  async createUser(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  async updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async searchUsers(query: string, currentUserId?: string) {
    if (!query || query.trim().length === 0) {
      return [];
    }

    return this.prisma.user.findMany({
      where: {
        AND: [
          currentUserId ? { id: { not: currentUserId } } : {},
          {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 20,
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
      },
    });
  }

  async createRefreshToken(data: {
    userId: string;
    token: string;
    expiresAt: Date;
  }) {
    return this.prisma.refreshToken.create({
      data,
    });
  }

  async findRefreshToken(token: string) {
    return this.prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true },
    });
  }

  async revokeRefreshToken(token: string) {
    return this.prisma.refreshToken.updateMany({
      where: { token },
      data: { revokedAt: new Date() },
    });
  }
}
