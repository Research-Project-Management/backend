import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, User } from '@prisma/client';

@Injectable()
export class AuthnRepository {
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

  async revokeAllUserTokens(userId: string) {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Explicit alias used by the password-reset flow. */
  async revokeAllUserRefreshTokens(userId: string) {
    return this.revokeAllUserTokens(userId);
  }

  /** Update only the password field for a given user. */
  async updateUserPassword(userId: string, hashedPassword: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  }
}

// Backward compatibility alias
export const AuthRepository = AuthnRepository;
export type AuthRepository = AuthnRepository;
