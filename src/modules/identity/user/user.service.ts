/**
 * User Management Service
 * Handles user profiles, password changes, personal preferences, resource metrics,
 * global search across user entities, and third-party federated identities.
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRepository } from './user.repository';
import { UpdateProfileDto } from './dto/profile.dto';
import { ChangePasswordDto } from './dto/password.dto';
import { UpdateUserSettingsDto } from './dto/settings.dto';
import { UserSearchResultItem } from './dto/search.dto';
import { sanitizeUser } from './utils/user.util';
import * as bcrypt from 'bcrypt';
import { AuthProvider } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  AUDIT_ACTIONS,
  AuditOutcome,
  AuditSeverity,
} from '../audit/types/audit.type';

@Injectable()
export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly auditService: AuditService,
  ) {}

  // ─── 1. Profile & Account ───────────────────────────────────────────────────

  /**
   * Retrieve authenticated user profile and personal preferences.
   */
  async getMe(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new UnauthorizedException(
        'User no longer exists. Please sign in again.',
      );
    }
    const settings = await this.userRepo.getUserSettings(userId);
    return {
      user: {
        ...sanitizeUser(user),
        settings,
      },
    };
  }

  /**
   * Update user display name and avatar.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.updateProfile(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(dto.institution !== undefined && { institution: dto.institution }),
    });

    return { user: sanitizeUser(user) };
  }

  /**
   * Change user password and revoke all active refresh tokens.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.userRepo.findById(userId);
    if (!user || !user.password) {
      throw new BadRequestException('User has no password set');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepo.updateUser(userId, {
      password: hashedPassword,
    });
    await this.userRepo.revokeAllUserRefreshTokens(userId);

    return { message: 'Password updated successfully' };
  }

  /**
   * Deactivate user account with Purpose-Based Selective Erasure (GDPR compliant).
   * - Enforces suspension check (suspended accounts cannot self-deactivate).
   * - Enforces Sole-Owner Protection: blocks deactivation if user is the sole owner of active collaborative projects.
   * - Auto-archives solo projects owned by this user.
   * - Anonymizes email to release it for future signups.
   * - Clears credentials and unlinks external OAuth accounts.
   * - Revokes all active refresh tokens.
   */
  async deleteMe(userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (user.status === 'suspended') {
      throw new BadRequestException(
        'Suspended accounts cannot be deactivated. Please contact support.',
      );
    }
    if (user.status === 'deactivated') {
      throw new BadRequestException('Account is already deactivated.');
    }

    // Check project ownership governance
    const ownedProjects = await this.userRepo.findOwnedProjects(userId);

    // Block deactivation if user owns active collaborative projects (memberCount > 1)
    const blockingProjects = ownedProjects.filter(
      (p) => !p.isArchived && p.memberCount > 1,
    );

    if (blockingProjects.length > 0) {
      throw new BadRequestException({
        code: 'SOLE_OWNER_OF_ACTIVE_PROJECTS',
        message:
          'Cannot deactivate account while being the sole owner of active collaborative projects. Please transfer ownership or delete the projects first.',
        blockingProjects: blockingProjects.map((p) => ({
          id: p.id,
          name: p.name,
          identifier: p.identifier,
          memberCount: p.memberCount,
        })),
      });
    }

    // Auto-archive solo projects (memberCount <= 1) to protect intellectual work without blocking user
    const soloProjectsToArchive = ownedProjects
      .filter((p) => !p.isArchived && p.memberCount <= 1)
      .map((p) => p.id);

    if (soloProjectsToArchive.length > 0) {
      await this.userRepo.archiveProjects(soloProjectsToArchive);
    }

    await this.userRepo.deactivateAccount(userId);

    await this.auditService.record({
      actorId: userId,
      action: AUDIT_ACTIONS.AUTH_ACCOUNT_DEACTIVATED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.warning,
      targetType: 'user',
      targetId: userId,
    });

    return { success: true, message: 'Account deactivated successfully' };
  }

  // ─── 2. Settings & Preferences ──────────────────────────────────────────────

  /**
   * Fetch personal settings and preferences.
   */
  async getSettings(userId: string) {
    const settings = await this.userRepo.getUserSettings(userId);
    return { settings };
  }

  /**
   * Update personal preferences, profile data, and timezone.
   */
  async updateSettings(userId: string, dto: UpdateUserSettingsDto) {
    if (dto.name !== undefined || dto.avatar !== undefined) {
      await this.userRepo.updateProfile(userId, {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      });
    }

    const updated = await this.userRepo.updateUserSettings(userId, {
      ...(dto.settings ?? {}),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
    });

    return {
      success: true,
      settings: updated,
      message: 'Settings updated successfully',
    };
  }

  // ─── 3. Resource Metrics ───────────────────────────────────────────────────

  /**
   * Aggregate resource metrics for the user dashboard.
   */
  async getUserStats(userId: string) {
    const stats = await this.userRepo.getUserStats(userId);
    return { stats };
  }

  // ─── 4. Search ─────────────────────────────────────────────────────────────

  /**
   * Search users by name or email for collaboration.
   */
  async searchUsers(query: string, currentUserId?: string) {
    const users = await this.userRepo.searchUsers(query, currentUserId);
    return { users };
  }

  /**
   * Global search across projects, work items, papers, pages, files, and stickies.
   */
  async searchAll(
    userId: string,
    query: string,
  ): Promise<UserSearchResultItem[]> {
    if (!query || !query.trim()) return [];
    const cleanQuery = query.trim();

    const [projects, workItems, papers, pages, files, stickies] =
      await Promise.all([
        this.userRepo.searchProjects(userId, cleanQuery),
        this.userRepo.searchWorkItems(userId, cleanQuery),
        this.userRepo.searchPapers(userId, cleanQuery),
        this.userRepo.searchPages(userId, cleanQuery),
        this.userRepo.searchFiles(userId, cleanQuery),
        this.userRepo.searchStickies(userId, cleanQuery),
      ]);

    const results: UserSearchResultItem[] = [
      ...projects.map(
        (project: {
          id: string;
          name: string;
          avatar: string | null;
          updatedAt: Date;
        }) => ({
          type: 'project' as const,
          id: project.id,
          name: project.name,
          icon: project.avatar || null,
          updatedAt: project.updatedAt,
        }),
      ),
      ...workItems.map(
        (workItem: {
          id: string;
          title: string;
          identifier: string;
          projectId: string;
          project?: { name: string };
          updatedAt: Date;
        }) => ({
          type: 'work_item' as const,
          id: workItem.id,
          name: workItem.title,
          identifier: workItem.identifier,
          projectId: workItem.projectId,
          projectName: workItem.project?.name,
          updatedAt: workItem.updatedAt,
        }),
      ),
      ...papers.map(
        (paper: { id: string; title: string; updatedAt: Date }) => ({
          type: 'paper' as const,
          id: paper.id,
          name: paper.title,
          updatedAt: paper.updatedAt,
        }),
      ),
      ...pages.map(
        (page: {
          id: string;
          title: string;
          projectId: string;
          project?: { name: string };
          updatedAt: Date;
        }) => ({
          type: 'page' as const,
          id: page.id,
          name: page.title,
          projectId: page.projectId,
          projectName: page.project?.name,
          updatedAt: page.updatedAt,
        }),
      ),
      ...files.map(
        (file: {
          id: string;
          filename: string;
          mimeType: string;
          size: number;
          isFolder: boolean;
          updatedAt: Date;
        }) => ({
          type: file.isFolder ? ('folder' as const) : ('file' as const),
          id: file.id,
          name: file.filename,
          mimeType: file.mimeType,
          size: file.size,
          updatedAt: file.updatedAt,
        }),
      ),
      ...stickies.map(
        (sticky: {
          id: string;
          title: string;
          content: string;
          color: string;
          updatedAt: Date;
        }) => ({
          type: 'sticky' as const,
          id: sticky.id,
          name: sticky.title || 'Untitled Sticky',
          color: sticky.color,
          updatedAt: sticky.updatedAt,
        }),
      ),
    ];

    return results.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  // ─── 5. Federated Identity & OAuth ──────────────────────────────────────────

  /**
   * Find linked third-party federated identity by provider and subject ID.
   */
  async findFederatedIdentity(provider: AuthProvider, subjectId: string) {
    return this.userRepo.findByProviderSubject(provider, subjectId);
  }

  /**
   * Link an external OAuth provider to an existing user account.
   */
  async linkFederatedIdentity(data: {
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email?: string;
    profileData?: Record<string, unknown>;
  }) {
    return this.userRepo.linkAccount(data);
  }

  /**
   * List all third-party identities linked to the user.
   */
  async getIdentities(userId: string) {
    const identities = await this.userRepo.findAccountsByUserId(userId);
    return { identities };
  }

  /**
   * Unlink a third-party identity provider from the user account.
   */
  async unlinkIdentity(userId: string, provider: AuthProvider) {
    await this.userRepo.unlinkAccount(userId, provider);

    await this.auditService.record({
      actorId: userId,
      action: AUDIT_ACTIONS.AUTH_OAUTH_ACCOUNT_UNLINKED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'user',
      targetId: userId,
      metadata: { provider },
    });

    return { success: true, message: `Account disconnected from ${provider}` };
  }
}
