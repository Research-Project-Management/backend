/**
 * User Data Access Repository
 * Encapsulates all Prisma database operations for users, credentials,
 * personal preferences, cross-resource entity search, and dashboard metrics.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { CitationStyle, Prisma, ThemePreference, User } from '@prisma/client';
import {
  IUserRepository,
  OwnedProjectInfo,
  UpdateUserSettingsInput,
  UserSettingsEntity,
  UserStatsResult,
  UserWithProfile,
} from './types/user.type';
import { formatBytes } from './utils/user.util';

import { isUuid } from '@/core/utils/uuid.util';

@Injectable()
export class UserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── 1. User Queries & Identity Management ──────────────────────────────────

  /**
   * Find a user by UUID.
   */
  async findById(id: string): Promise<UserWithProfile | null> {
    if (!id || !isUuid(id)) return null;
    return this.prisma.user.findUnique({
      where: { id },
      include: { profile: true },
    });
  }

  /**
   * Find a user by email address (case-insensitive).
   */
  async findByEmail(email: string): Promise<UserWithProfile | null> {
    if (!email) return null;
    return this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { profile: true },
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
  }): Promise<UserWithProfile> {
    return this.prisma.user.create({
      data: {
        email: data.email.toLowerCase().trim(),
        password: data.passwordHash,
        status: 'pending_verification',
        settings: {
          create: {},
        },
        profile: {
          create: {
            name: data.name,
            avatar: data.avatar ?? null,
          },
        },
      },
      include: { profile: true },
    });
  }

  /**
   * Update basic profile fields (name, avatar, and academic metadata).
   */
  async updateProfile(
    id: string,
    data: {
      name?: string;
      avatar?: string | null;
      bio?: string | null;
      institution?: string | null;
      department?: string | null;
      academicTitle?: string | null;
      orcidId?: string | null;
      website?: string | null;
    },
  ): Promise<UserWithProfile> {
    await this.prisma.userProfile.upsert({
      where: { userId: id },
      create: {
        userId: id,
        name: data.name ?? 'User',
        avatar: data.avatar ?? null,
        bio: data.bio ?? '',
        institution: data.institution ?? null,
        department: data.department ?? null,
        academicTitle: data.academicTitle ?? null,
        orcidId: data.orcidId ?? null,
        website: data.website ?? null,
      },
      update: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.avatar !== undefined ? { avatar: data.avatar } : {}),
        ...(data.bio !== undefined ? { bio: data.bio } : {}),
        ...(data.institution !== undefined
          ? { institution: data.institution }
          : {}),
        ...(data.department !== undefined
          ? { department: data.department }
          : {}),
        ...(data.academicTitle !== undefined
          ? { academicTitle: data.academicTitle }
          : {}),
        ...(data.orcidId !== undefined ? { orcidId: data.orcidId } : {}),
        ...(data.website !== undefined ? { website: data.website } : {}),
      },
    });

    const user = await this.findById(id);
    if (!user) throw new Error('User not found');
    return user;
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
   * Soft-delete a user account (delegates to deactivateAccount).
   */
  async softDelete(id: string): Promise<void> {
    return this.deactivateAccount(id);
  }

  /**
   * Deactivate and anonymize user account (GDPR Purpose-Based Selective Erasure).
   * - Frees the real email by mutating it to anonymized_<id>@deleted.flux
   * - Wipes password hash and unlinks third-party OAuth accounts
   * - Sets deletedAt timestamp and deactivated status
   * - Revokes all active refresh tokens
   * - Preserves academic research contributions and historical author identity
   */
  async deactivateAccount(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 1. Delete third-party federated OAuth accounts
      await tx.userAccount.deleteMany({
        where: { userId: id },
      });

      // 2. Anonymize user profile
      await tx.userProfile.updateMany({
        where: { userId: id },
        data: {
          name: 'Deactivated User',
          avatar: null,
          bio: '',
          institution: null,
          department: null,
          academicTitle: null,
          orcidId: null,
          website: null,
        },
      });

      // 3. Anonymize email and clear password
      await tx.user.update({
        where: { id },
        data: {
          email: `anonymized_${id}@deleted.flux`,
          password: null,
          deletedAt: new Date(),
          status: 'deactivated',
        },
      });

      // 4. Revoke all active refresh tokens
      await tx.refreshToken.updateMany({
        where: {
          userId: id,
          isRevoked: false,
        },
        data: {
          isRevoked: true,
          revokedAt: new Date(),
        },
      });
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
  ): Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      avatar: string | null;
      status: User['status'];
    }>
  > {
    const cleanQuery = query?.trim() ?? '';

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        ...(projectId ? { projectMembers: { some: { projectId } } } : {}),
        AND: [
          excludeUserId ? { id: { not: excludeUserId } } : {},
          cleanQuery
            ? {
                OR: [
                  {
                    profile: {
                      name: { contains: cleanQuery, mode: 'insensitive' },
                    },
                  },
                  { email: { contains: cleanQuery, mode: 'insensitive' } },
                ],
              }
            : {},
        ],
      },
      select: {
        id: true,
        email: true,
        status: true,
        profile: {
          select: {
            name: true,
            avatar: true,
          },
        },
      },
      take: 20,
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      status: u.status,
      name: u.profile?.name ?? 'User',
      avatar: u.profile?.avatar ?? null,
    }));
  }

  /**
   * Find all non-deleted projects where the user is an owner,
   * including the total member count and archive status.
   */
  async findOwnedProjects(userId: string): Promise<OwnedProjectInfo[]> {
    if (!userId || !isUuid(userId)) return [];

    const memberships = await this.prisma.projectMember.findMany({
      where: {
        userId,
        role: 'owner',
        project: {
          deletedAt: null,
        },
      },
      select: {
        project: {
          select: {
            id: true,
            name: true,
            identifier: true,
            isArchived: true,
            _count: {
              select: {
                members: true,
              },
            },
          },
        },
      },
    });

    return memberships.map((m) => ({
      id: m.project.id,
      name: m.project.name,
      identifier: m.project.identifier,
      isArchived: m.project.isArchived,
      memberCount: m.project._count.members,
    }));
  }

  /**
   * Bulk archive projects by IDs.
   */
  async archiveProjects(projectIds: string[]): Promise<number> {
    const validIds = projectIds.filter((id) => isUuid(id));
    if (validIds.length === 0) return 0;

    const result = await this.prisma.project.updateMany({
      where: {
        id: { in: validIds },
        deletedAt: null,
      },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    return result.count;
  }

  // ─── 2. Personal Preferences & Settings ─────────────────────────────────────

  /**
   * Retrieve personal settings and preferences.
   */
  async getUserSettings(userId: string): Promise<UserSettingsEntity> {
    let settings = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    if (!settings) {
      settings = await this.prisma.userSettings.create({
        data: { userId },
      });
    }

    return {
      theme: settings.theme,
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
    settings: UpdateUserSettingsInput,
  ): Promise<UserSettingsEntity> {
    const existing = await this.prisma.userSettings.findUnique({
      where: { userId },
    });

    if (!existing) {
      const created = await this.prisma.userSettings.create({
        data: {
          userId,
          theme: (settings.theme as ThemePreference) || ThemePreference.system,
          citationStyle:
            (settings.citationStyle as CitationStyle) || CitationStyle.apa,
          locale: settings.locale || 'en',
          editorConfig: (settings.editorConfig as Prisma.InputJsonValue) ?? {},
          notifications:
            (settings.notifications as Prisma.InputJsonValue) ?? {},
          aiPreferences:
            (settings.aiPreferences as Prisma.InputJsonValue) ?? {},
        },
      });
      return {
        theme: created.theme,
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
          ? { citationStyle: settings.citationStyle }
          : {}),
        ...(settings.locale ? { locale: settings.locale } : {}),
        ...(settings.editorConfig !== undefined
          ? { editorConfig: settings.editorConfig }
          : {}),
        ...(settings.notifications !== undefined
          ? { notifications: settings.notifications }
          : {}),
        ...(settings.aiPreferences !== undefined
          ? { aiPreferences: settings.aiPreferences }
          : {}),
      },
    });

    return {
      theme: updated.theme,
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

  getUserStats(_userId: string): Promise<UserStatsResult> {
    const plan = 'free';
    const storageQuotaBytes = 5 * 1024 * 1024 * 1024;

    return Promise.resolve({
      projectsCount: 0,
      filesCount: 0,
      storageUsedBytes: 0,
      storageQuotaBytes,
      storageUsedFormatted: formatBytes(0),
      stickiesCount: 0,
      workItemsCount: 0,
      plan,
    });
  }
}
