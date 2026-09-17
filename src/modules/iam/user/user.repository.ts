/**
 * User Data Access Repository
 * Encapsulates all Prisma database operations for users, credentials,
 * personal preferences, cross-resource entity search, and dashboard metrics.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, User } from '@prisma/client';
import {
  IUserRepository,
  UserSettingsData,
  UserStatsResult,
} from './types/user.type';
import { formatBytes } from './utils/user.util';

function isUuid(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    str,
  );
}

@Injectable()
export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── 1. User Queries & Identity Management ──────────────────────────────────

  /**
   * Find a user by UUID.
   */
  async findById(id: string): Promise<User | null> {
    if (!id || !isUuid(id)) return null;
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  /**
   * Find a user by email address (case-insensitive).
   */
  async findByEmail(email: string): Promise<User | null> {
    if (!email) return null;
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
  }

  /**
   * Create a new local authentication user.
   */
  async createWithLocalAuth(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar?: string;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase().trim(),
        password: data.passwordHash,
        name: data.name,
        avatar: data.avatar ?? null,
        status: 'active',
      },
    });
  }

  /**
   * Update basic profile fields (name, avatar, isVerified).
   */
  async updateProfile(
    id: string,
    data: Partial<Pick<User, 'name' | 'avatar' | 'isVerified'>>,
  ): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  /**
   * Generic user update method for account administration.
   */
  async updateUser(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  /**
   * Soft-delete a user account by setting deletedAt timestamp.
   */
  async softDelete(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'deactivated',
      },
    });
  }

  /**
   * Revoke all active refresh tokens for a user.
   */
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

  /**
   * Search users across the platform by name or email.
   */
  async searchUsers(
    query: string,
    excludeUserId?: string,
    projectId?: string,
  ): Promise<Array<Pick<User, 'id' | 'name' | 'email' | 'avatar' | 'status'>>> {
    const cleanQuery = query?.trim() ?? '';

    return this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(projectId ? { projectMembers: { some: { projectId } } } : {}),
        AND: [
          excludeUserId ? { id: { not: excludeUserId } } : {},
          cleanQuery
            ? {
                OR: [
                  { name: { contains: cleanQuery, mode: 'insensitive' } },
                  { email: { contains: cleanQuery, mode: 'insensitive' } },
                ],
              }
            : {},
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

  // ─── 2. Personal Preferences & Settings ─────────────────────────────────────

  /**
   * Retrieve personal settings and preferences.
   */
  async getUserSettings(userId: string): Promise<UserSettingsData> {
    const settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });
    if (!settings) {
      return {
        theme: 'system',
        citationStyle: 'apa',
        locale: 'en',
      };
    }
    return {
      theme: (settings.theme as 'light' | 'dark' | 'system') || 'system',
      citationStyle: settings.citationStyle,
      locale: settings.locale,
      editorConfig: settings.editorConfig ?? {},
      notifications: (settings.notifications as Record<string, unknown>) ?? {},
      aiPreferences: settings.aiPreferences ?? {},
    };
  }

  /**
   * Update personal preferences and configuration.
   */
  async updateUserSettings(
    userId: string,
    settings: Partial<UserSettingsData>,
  ): Promise<UserSettingsData> {
    const existing = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    if (!existing) {
      const created = await this.prisma.userSettings.create({
        data: {
          userId,
          theme: settings.theme || 'system',
          citationStyle: (settings.citationStyle as string) || 'apa',
          locale: (settings.locale as string) || 'en',
          editorConfig: (settings.editorConfig as Prisma.InputJsonValue) ?? {},
          notifications:
            (settings.notifications as Prisma.InputJsonValue) ?? {},
          aiPreferences:
            (settings.aiPreferences as Prisma.InputJsonValue) ?? {},
        },
      });
      return {
        theme: (created.theme as 'light' | 'dark' | 'system') || 'system',
        citationStyle: created.citationStyle,
        locale: created.locale,
        editorConfig: created.editorConfig ?? {},
        notifications: (created.notifications as Record<string, unknown>) ?? {},
        aiPreferences: created.aiPreferences ?? {},
      };
    }

    const updated = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        ...(settings.theme ? { theme: settings.theme } : {}),
        ...(settings.citationStyle
          ? { citationStyle: settings.citationStyle as string }
          : {}),
        ...(settings.locale ? { locale: settings.locale as string } : {}),
        ...(settings.editorConfig
          ? { editorConfig: settings.editorConfig }
          : {}),
        ...(settings.notifications
          ? { notifications: settings.notifications }
          : {}),
        ...(settings.aiPreferences
          ? { aiPreferences: settings.aiPreferences }
          : {}),
      },
    });

    return {
      theme: (updated.theme as 'light' | 'dark' | 'system') || 'system',
      citationStyle: updated.citationStyle,
      locale: updated.locale,
      editorConfig: updated.editorConfig ?? {},
      notifications: (updated.notifications as Record<string, unknown>) ?? {},
      aiPreferences: updated.aiPreferences ?? {},
    };
  }

  // ─── 3. Cross-Resource Entity Search (Stubs for Microservice Isolation) ──────

  async searchProjects(
    userId: string,
    query: string,
  ): Promise<
    Array<{ id: string; name: string; avatar: string | null; updatedAt: Date }>
  > {
    try {
      return await this.prisma.project.findMany({
        where: {
          deletedAt: null,
          members: { some: { userId } },
          name: { contains: query, mode: 'insensitive' },
        },
        select: { id: true, name: true, avatar: true, updatedAt: true },
        take: 10,
      });
    } catch {
      return [];
    }
  }

  async searchWorkItems(
    userId: string,
    query: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      identifier: string;
      projectId: string;
      project?: { name: string };
      updatedAt: Date;
    }>
  > {
    try {
      const items = await this.prisma.workItem.findMany({
        where: {
          deletedAt: null,
          project: { members: { some: { userId } }, deletedAt: null },
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { identifier: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          title: true,
          identifier: true,
          projectId: true,
          project: { select: { name: true } },
          updatedAt: true,
        },
        take: 10,
      });
      return items.map((i) => ({
        ...i,
        identifier: i.identifier || '',
      }));
    } catch {
      return [];
    }
  }

  async searchPapers(
    userId: string,
    query: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: Date }>> {
    try {
      return await this.prisma.item.findMany({
        where: {
          userId,
          deletedAt: null,
          title: { contains: query, mode: 'insensitive' },
        },
        select: { id: true, title: true, updatedAt: true },
        take: 10,
      });
    } catch {
      return [];
    }
  }

  async searchPages(
    userId: string,
    query: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      projectId: string;
      project?: { name: string };
      updatedAt: Date;
    }>
  > {
    try {
      return await this.prisma.page.findMany({
        where: {
          deletedAt: null,
          project: { members: { some: { userId } }, deletedAt: null },
          title: { contains: query, mode: 'insensitive' },
        },
        select: {
          id: true,
          title: true,
          projectId: true,
          project: { select: { name: true } },
          updatedAt: true,
        },
        take: 10,
      });
    } catch {
      return [];
    }
  }

  async searchFiles(
    userId: string,
    query: string,
  ): Promise<
    Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      isFolder: boolean;
      updatedAt: Date;
    }>
  > {
    try {
      const files = await this.prisma.file.findMany({
        where: {
          authorId: userId,
          trashedAt: null,
          filename: { contains: query, mode: 'insensitive' },
        },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          size: true,
          isFolder: true,
          updatedAt: true,
        },
        take: 10,
      });
      return files.map((f) => ({
        ...f,
        size: Number(f.size),
      }));
    } catch {
      return [];
    }
  }

  async searchStickies(
    userId: string,
    query: string,
  ): Promise<
    Array<{
      id: string;
      title: string;
      content: string;
      color: string;
      updatedAt: Date;
    }>
  > {
    try {
      const stickies = await this.prisma.sticky.findMany({
        where: {
          userId,
          deletedAt: null,
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { content: { contains: query, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          title: true,
          content: true,
          color: true,
          updatedAt: true,
        },
        take: 10,
      });
      return stickies.map((s) => ({
        ...s,
        title: s.title || 'Untitled Sticky',
      }));
    } catch {
      return [];
    }
  }

  // ─── 4. Resource Statistics & Dashboard Metrics ─────────────────────────────

  async getUserStats(_userId: string): Promise<UserStatsResult> {
    const plan = 'free';
    const storageQuotaBytes = 5 * 1024 * 1024 * 1024;

    return {
      projectsCount: 0,
      filesCount: 0,
      storageUsedBytes: 0,
      storageQuotaBytes,
      storageUsedFormatted: formatBytes(0),
      stickiesCount: 0,
      workItemsCount: 0,
      plan,
    };
  }
}
