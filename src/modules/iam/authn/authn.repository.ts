import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, User, RefreshToken } from '@prisma/client';
import { IRefreshTokenRepository } from '../types/iam-repository.interface';
import * as crypto from 'crypto';

@Injectable()
export class AuthnRepository implements IRefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  private normalizeTokenHash(token: string): string {
    if (/^[a-f0-9]{64}$/i.test(token)) {
      return token.toLowerCase();
    }

    return crypto.createHash('sha256').update(token).digest('hex');
  }

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

  /**
   * Creates a new Refresh Token / Session record with token hash and optional family lineage.
   */
  async createSession(data: {
    userId: string;
    token?: string;
    tokenHash: string;
    familyId?: string;
    parentId?: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
    deviceType?: string;
  }): Promise<RefreshToken> {
    const tokenHash = this.normalizeTokenHash(data.tokenHash);
    return this.prisma.refreshToken.create({
      data: {
        userId: data.userId,
        token: tokenHash,
        tokenHash,
        familyId: data.familyId,
        parentId: data.parentId ?? null,
        expiresAt: data.expiresAt,
        userAgent: data.userAgent ?? null,
        ipAddress: data.ipAddress ?? null,
        deviceType: data.deviceType ?? null,
        isRevoked: false,
      },
    });
  }

  /** Backward-compatible alias */
  async createRefreshToken(data: {
    userId: string;
    token: string;
    expiresAt: Date;
  }): Promise<RefreshToken> {
    const tokenHash = this.normalizeTokenHash(data.token);
    return this.createSession({
      userId: data.userId,
      tokenHash,
      expiresAt: data.expiresAt,
    });
  }

  async findRefreshToken(tokenHash: string) {
    return this.prisma.refreshToken.findFirst({
      where: {
        OR: [{ tokenHash }, { token: tokenHash }],
      },
      include: { user: true },
    });
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findFirst({
      where: {
        OR: [{ tokenHash }, { token: tokenHash }],
      },
    });
  }

  /**
   * Rotates a refresh token: revokes old token and issues child token with same familyId.
   */
  async rotateToken(params: {
    oldTokenId: string;
    newTokenHash: string;
    familyId: string;
    userId: string;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<RefreshToken> {
    return this.prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: {
          id: params.oldTokenId,
          userId: params.userId,
          isRevoked: false,
          expiresAt: { gt: new Date() },
        },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
        },
      });

      if (revoked.count !== 1) {
        throw new Error('Refresh token already used or expired');
      }

      const newTokenHash = this.normalizeTokenHash(params.newTokenHash);
      return tx.refreshToken.create({
        data: {
          userId: params.userId,
          token: newTokenHash,
          tokenHash: newTokenHash,
          familyId: params.familyId,
          parentId: params.oldTokenId,
          expiresAt: params.expiresAt,
          userAgent: params.userAgent ?? null,
          ipAddress: params.ipAddress ?? null,
          isRevoked: false,
        },
      });
    });
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        id: sessionId,
        userId,
        isRevoked: false,
      },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  async revokeToken(id: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
  }

  async revokeRefreshToken(token: string) {
    return this.prisma.refreshToken.updateMany({
      where: {
        OR: [{ token }, { tokenHash: token }],
      },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
  }

  /**
   * Revokes all tokens belonging to a family (used when breach/replay is detected).
   */
  async revokeFamily(familyId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
        familyId,
        isRevoked: false,
      },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  async revokeAllUserTokens(userId: string) {
    return this.prisma.refreshToken.updateMany({
      where: {
        userId,
        isRevoked: false,
      },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
      },
    });
  }

  async revokeAllUserSessions(userId: string): Promise<number> {
    const res = await this.revokeAllUserTokens(userId);
    return res.count;
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

  async findActiveSessionsByUser(userId: string): Promise<RefreshToken[]> {
    return this.prisma.refreshToken.findMany({
      where: {
        userId,
        isRevoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { lastUsedAt: 'desc' },
      take: 50,
    });
  }
}

// Backward compatibility alias
export const AuthRepository = AuthnRepository;
export type AuthRepository = AuthnRepository;
