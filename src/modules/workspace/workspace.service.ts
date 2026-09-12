import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceInvitationRepository } from './workspace-invitation.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { MailService } from '@/core/mail/mail.service';
import { WORKSPACE_REDIS_KEYS } from './constants/redis-keys.constant';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  CreateWorkspaceInvitationDto,
  AddWorkspaceMemberDto,
  UpdateWorkspaceMemberDto,
} from './dto/workspace.dto';
import { SearchResultItem } from './dto/search-result.dto';
import { Prisma, WorkspaceMemberRole } from '@prisma/client';
import * as crypto from 'crypto';
import { generateWorkspaceSlug } from './utils/workspace.utils';

@Injectable()
export class WorkspaceService {
  private static readonly WS_CACHE_TTL = 3600; // 1 hour
  private static readonly USER_WS_CACHE_TTL = 1800; // 30 mins

  constructor(
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly invitationRepo: WorkspaceInvitationRepository,
    private readonly cache: RedisCacheService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  async getMyWorkspaces(userId: string) {
    const cacheKey = WORKSPACE_REDIS_KEYS.userWorkspaces(userId);
    return this.cache.wrap(
      cacheKey,
      async () => {
        const workspaces = await this.workspaceRepo.findUserWorkspaces(userId);
        return { workspaces };
      },
      WorkspaceService.USER_WS_CACHE_TTL,
    );
  }

  async getWorkspace(workspaceIdOrSlug: string, userId: string) {
    const workspace =
      await this.workspaceRepo.findByIdOrSlug(workspaceIdOrSlug);

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // Personal workspace model: user is the owner (ownerId === userId)
    const isOwner = workspace.ownerId === userId;
    return {
      workspace,
      yourRole: isOwner ? 'owner' : null,
    };
  }

  async createWorkspace(userId: string, dto: CreateWorkspaceDto) {
    const targetSlug = generateWorkspaceSlug(dto.name, dto.slug, dto.url);

    if (!targetSlug) {
      throw new BadRequestException('Valid workspace URL/slug is required');
    }

    const existingWorkspace = await this.workspaceRepo.findBySlug(targetSlug);

    if (existingWorkspace) {
      throw new BadRequestException('Workspace URL/slug is already taken');
    }

    const inviteCode = crypto.randomBytes(4).toString('hex');
    const workspace = await this.workspaceRepo.createWorkspace({
      name: dto.name,
      slug: targetSlug,
      url: targetSlug,
      avatar: dto.avatar || '',
      companySize: dto.companySize || '',
      plan: dto.plan || 'free',
      inviteCode,
      createdById: userId,
      ownerId: userId, // Personal workspace: creator is the owner (1-to-1)
      settings: (dto.settings as Prisma.InputJsonValue) ?? {},
    });

    await this.invalidateUserWorkspacesCache(userId);

    return { workspace };
  }

  async updateWorkspace(workspaceId: string, dto: UpdateWorkspaceDto) {
    const targetSlug = dto.slug || dto.url;

    if (targetSlug) {
      const existing = await this.workspaceRepo.findBySlug(targetSlug);
      if (existing && existing.id !== workspaceId) {
        throw new BadRequestException('Workspace URL/slug is already taken');
      }
    }

    const workspace = await this.workspaceRepo.updateWorkspace(workspaceId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(targetSlug !== undefined && { slug: targetSlug, url: targetSlug }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(dto.companySize !== undefined && { companySize: dto.companySize }),
      ...(dto.plan !== undefined && { plan: dto.plan }),
      ...(dto.settings !== undefined && {
        settings: dto.settings as Prisma.InputJsonValue,
      }),
    });

    await this.invalidateWorkspaceCache(
      workspaceId,
      workspace.slug || workspace.url,
    );

    return { workspace };
  }

  async deleteWorkspace(workspaceId: string, userId: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    await this.workspaceRepo.softDeleteWorkspace(workspaceId);
    await Promise.all([
      this.invalidateWorkspaceCache(
        workspaceId,
        workspace.slug || workspace.url,
      ),
      this.invalidateUserWorkspacesCache(userId),
    ]);

    return { message: 'Workspace deleted successfully' };
  }

  async restoreWorkspace(workspaceId: string, userId: string) {
    const workspace = await this.workspaceRepo.restoreWorkspace(workspaceId);

    await Promise.all([
      this.invalidateWorkspaceCache(
        workspaceId,
        workspace.slug || workspace.url,
      ),
      this.invalidateUserWorkspacesCache(userId),
    ]);

    return { message: 'Workspace restored successfully', workspace };
  }

  // ── Workspace Member Management (DEPRECATED) ─────────────────────────────
  // In the personal-workspace model, there are no workspace-level members.
  // Collaboration is handled at the Project level via ProjectMember.
  // These methods are kept as stubs to avoid breaking existing routes until
  // Phase 4 frontend cleanup and Phase 5 controller cleanup is complete.

  /** @deprecated Use project members instead */
  async getMembers(workspaceId: string) {
    // Return empty list — workspace no longer has members
    return { members: [], deprecated: true };
  }

  /** @deprecated Workspace membership no longer exists */
  async addMember(_workspaceId: string, _dto: unknown) {
    throw new ForbiddenException(
      'Workspace member management is disabled. Invite users to specific projects instead.',
    );
  }

  /** @deprecated Workspace membership no longer exists */
  async updateMember(_workspaceId: string, _userId: string, _dto: unknown) {
    throw new ForbiddenException(
      'Workspace member management is disabled. Manage roles at the project level.',
    );
  }

  /** @deprecated Workspace membership no longer exists */
  async removeMember(_workspaceId: string, _userId: string) {
    throw new ForbiddenException(
      'Workspace member management is disabled. Remove from specific projects instead.',
    );
  }

  /** @deprecated Workspace invite codes are disabled in personal workspace model */
  async joinByCode(_userId: string, _inviteCode: string) {
    throw new ForbiddenException(
      'Workspace invite codes are disabled. Users get their own workspace on registration.',
    );
  }

  /** @deprecated No-op in personal workspace model */
  async leaveWorkspace(_workspaceId: string, _userId: string) {
    throw new ForbiddenException(
      'You cannot leave your personal workspace. Your workspace is created automatically on registration.',
    );
  }

  // ── Invitations Lifecycle ──────────────────────────────────────────────────

  async createInvitation(
    workspaceId: string,
    invitedById: string,
    dto: CreateWorkspaceInvitationDto,
  ) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    // Support both single email and batch emails
    const rawDto = dto as any;
    const emails: string[] = Array.isArray(rawDto.emails)
      ? rawDto.emails
          .map((e: any) => (typeof e === 'string' ? e : e?.email))
          .filter(Boolean)
      : dto.email
        ? [dto.email]
        : [];

    if (emails.length === 0) {
      throw new BadRequestException('At least one email is required');
    }

    const expiresInDays = dto.expiresInDays || 7;
    const createdInvitations: any[] = [];
    const skipped: any[] = [];

    for (const rawEmail of emails) {
      const email = rawEmail.trim().toLowerCase();
      try {
        const invitation = await this.invitationRepo.createInvitation({
          workspaceId,
          email,
          invitedById,
          expiresInDays,
        });

        createdInvitations.push(invitation);

        if (this.mailService) {
          try {
            await this.mailService.sendWorkspaceInvite({
              to: email,
              inviterName: 'A team member',
              workspaceName: workspace.name,
              workspaceUrl: workspace.url || workspace.id,
              role: (dto.role as string) || 'member',
              token: invitation.token,
              expiresAt: invitation.expiresAt,
            });
          } catch {
            // Non-blocking mail failure
          }
        }
      } catch (err: any) {
        skipped.push({
          email,
          reason: err.message || 'Failed to create invite',
        });
      }
    }

    await this.cache.del(WORKSPACE_REDIS_KEYS.pendingInvitations(workspaceId));

    return {
      message: `Sent ${createdInvitations.length} invitation(s)`,
      invitation: createdInvitations[0],
      invitations: createdInvitations,
      skipped,
    };
  }

  async getInvitationByToken(token: string) {
    const invitation = await this.invitationRepo.findByToken(token);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return {
      invitation,
      workspace: invitation.workspace,
      invitedBy: invitation.invitedBy,
    };
  }

  async declineInvitation(token: string) {
    const invitation = await this.invitationRepo.findByToken(token);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== 'pending') {
      throw new BadRequestException(
        `Invitation is already ${invitation.status}`,
      );
    }
    await this.invitationRepo.updateStatus(invitation.id, 'declined');
    await this.cache.del(
      WORKSPACE_REDIS_KEYS.pendingInvitations(invitation.workspaceId),
    );
    return { message: 'Invitation declined successfully' };
  }

  async listPendingInvitations(workspaceId: string) {
    const cacheKey = WORKSPACE_REDIS_KEYS.pendingInvitations(workspaceId);
    return this.cache.wrap(
      cacheKey,
      async () => {
        const invitations =
          await this.invitationRepo.listPendingByWorkspace(workspaceId);
        return { invitations };
      },
      600,
    );
  }

  async acceptInvitation(userId: string, token: string) {
    const invitation = await this.invitationRepo.findByToken(token);

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new BadRequestException(
        `Invitation is already ${invitation.status}`,
      );
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      await this.invitationRepo.updateStatus(invitation.id, 'expired');
      throw new BadRequestException('Invitation has expired');
    }

    await this.workspaceRepo.withTransaction(async (tx) => {
      const existingMember = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
      });

      if (!existingMember) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId,
            role: invitation.role,
          },
        });
      }

      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'accepted',
          acceptedAt: new Date(),
        },
      });
    });

    await Promise.all([
      this.invalidateUserWorkspacesCache(userId),
      this.cache.del(
        WORKSPACE_REDIS_KEYS.pendingInvitations(invitation.workspaceId),
      ),
    ]);

    return {
      message: 'Invitation accepted successfully',
      workspaceId: invitation.workspaceId,
      workspace: invitation.workspace,
    };
  }

  async revokeInvitation(workspaceId: string, invitationId: string) {
    const invitation = await this.invitationRepo.revokeInvitation(invitationId);
    await this.cache.del(WORKSPACE_REDIS_KEYS.pendingInvitations(workspaceId));
    return { message: 'Invitation revoked successfully', invitation };
  }

  // ── Global Search ──────────────────────────────────────────────────────────

  async search(
    workspaceId: string,
    query: string,
    userId?: string,
  ): Promise<SearchResultItem[]> {
    if (!workspaceId || !workspaceId.trim()) {
      throw new BadRequestException('Workspace context is required for search');
    }

    if (!query || !query.trim()) return [];

    const ws = await this.workspaceRepo.findByIdOrSlug(workspaceId);
    if (!ws) {
      throw new NotFoundException('Workspace not found');
    }
    const canonicalWorkspaceId = ws.id;

    if (userId) {
      const isMember = ws.members?.some((m) => m.userId === userId);
      if (!isMember) {
        const member = await this.workspaceRepo.findMember(
          canonicalWorkspaceId,
          userId,
        );
        if (!member) {
          throw new ForbiddenException(
            'You are not a member of this workspace',
          );
        }
      }
    }

    const cleanQuery = query.trim();

    const [projects, tasks, papers, pages, files, stickies] = await Promise.all(
      [
        this.workspaceRepo.searchProjects(canonicalWorkspaceId, cleanQuery),
        this.workspaceRepo.searchTasks(canonicalWorkspaceId, cleanQuery),
        this.workspaceRepo.searchPapers(canonicalWorkspaceId, cleanQuery),
        this.workspaceRepo.searchPages(canonicalWorkspaceId, cleanQuery),
        this.workspaceRepo.searchFiles(canonicalWorkspaceId, cleanQuery),
        this.workspaceRepo.searchStickies(canonicalWorkspaceId, cleanQuery),
      ],
    );

    const results: SearchResultItem[] = [
      ...projects.map((project: any) => ({
        type: 'project' as const,
        id: project.id,
        name: project.name,
        icon: project.avatar || null,
        updatedAt: project.updatedAt,
      })),
      ...tasks.map((task: any) => ({
        type: 'task' as const,
        id: task.id,
        name: task.title,
        identifier: task.identifier,
        projectId: task.projectId,
        projectName: task.project?.name,
        updatedAt: task.updatedAt,
      })),
      ...papers.map((paper: any) => ({
        type: 'paper' as const,
        id: paper.id,
        name: paper.title,
        updatedAt: paper.updatedAt,
      })),
      ...pages.map((page: any) => ({
        type: 'page' as const,
        id: page.id,
        name: page.title,
        projectId: page.projectId,
        projectName: page.project?.name,
        updatedAt: page.updatedAt,
      })),
      ...files.map((file: any) => ({
        type: file.isFolder ? ('folder' as const) : ('file' as const),
        id: file.id,
        name: file.filename,
        mimeType: file.mimeType,
        size: file.size,
        updatedAt: file.updatedAt,
      })),
      ...stickies.map((sticky: any) => ({
        type: 'sticky' as const,
        id: sticky.id,
        name: sticky.title || 'Untitled Sticky',
        color: sticky.color,
        updatedAt: sticky.updatedAt,
      })),
    ];

    return results.sort(
      (previousItem, nextItem) =>
        new Date(nextItem.updatedAt).getTime() -
        new Date(previousItem.updatedAt).getTime(),
    );
  }

  // ── Cache Invalidation Helpers ─────────────────────────────────────────────

  private async invalidateWorkspaceCache(
    workspaceId: string,
    slug?: string | null,
  ) {
    const keys = [
      WORKSPACE_REDIS_KEYS.workspace(workspaceId),
      ...(slug ? [WORKSPACE_REDIS_KEYS.slug(slug)] : []),
    ];
    await Promise.all(keys.map((k) => this.cache.del(k)));
  }

  private async invalidateUserWorkspacesCache(userId: string) {
    await this.cache.del(WORKSPACE_REDIS_KEYS.userWorkspaces(userId));
  }
}
