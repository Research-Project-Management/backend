import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, User } from '@prisma/client';
import { IUserRepository } from '../types/iam-repository.interface';

@Injectable()
export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  /** Backward-compatible alias */
  async findUserById(id: string): Promise<User | null> {
    return this.findById(id);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
  }

  async createWithLocalAuth(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase(),
        password: data.passwordHash,
        name: data.name,
        avatar: data.avatar ?? null,
        status: 'active',
      },
    });
  }

  async updateProfile(
    id: string,
    data: Partial<Pick<User, 'name' | 'avatar' | 'isVerified'>>,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'deactivated',
      },
    });
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: {
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

  async searchUsers(query: string, excludeUserId?: string) {
    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        AND: [
          excludeUserId ? { id: { not: excludeUserId } } : {},
          {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        name: true,
        email: true,
        avatar: true,
        status: true,
      },
      take: 20,
    });
  }

  async deleteUser(id: string): Promise<User> {
    return this.prisma.user.delete({ where: { id } });
  }
}
