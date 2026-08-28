import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { WorkspaceRepository } from './workspace.repository';
import { WorkspaceInvitationRepository } from './workspace-invitation.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { WORKSPACE_REDIS_KEYS } from './constants/redis-keys.constant';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  AddWorkspaceMemberDto,
  UpdateWorkspaceMemberDto,
  CreateWorkspaceInvitationDto,
} from './dto/workspace.dto';
import { SearchResultItem } from './dto/search-result.dto';
import { WorkspaceMemberRole } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class WorkspaceService {
  private static readonly WS_CACHE_TTL = 3600; // 1 hour
  private static readonly USER_WS_CACHE_TTL = 1800; // 30 mins

  constructor(
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly invitationRepo: WorkspaceInvitationRepository,
    private readonly cache: RedisCacheService,
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

    const member = workspace.members.find(
      (workspaceMember) => workspaceMember.userId === userId,
    );
    return {
      workspace,
      yourRole: member?.role || WorkspaceMemberRole.member,
    };
  }

  async createWorkspace(userId: string, dto: CreateWorkspaceDto) {
    const targetSlug =
      dto.slug ||
      dto.url ||
      dto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

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
      settings: (dto.settings as any) || {},
      members: {
        create: {
          userId,
          role: WorkspaceMemberRole.owner,
        },
      },
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
      ...(dto.settings !== undefined && { settings: dto.settings as any }),
    });

    await this.invalidateWorkspaceCache(
      workspaceId,
      workspace.slug || workspace.url,
    );

    return { workspace };
  }

  async deleteWorkspace(workspaceId: string) {
    const workspace = await this.workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    await this.workspaceRepo.softDeleteWorkspace(workspaceId);
    await this.invalidateWorkspaceCache(
      workspaceId,
      workspace.slug || workspace.url,
    );

    return { message: 'Workspace deleted successfully' };
  }

  async restoreWorkspace(workspaceId: string) {
    const workspace = await this.workspaceRepo.restoreWorkspace(workspaceId);
    await this.invalidateWorkspaceCache(
      workspaceId,
      workspace.slug || workspace.url,
    );

    return { message: 'Workspace restored successfully', workspace };
  }

  async getMembers(workspaceId: string) {
    const members = await this.workspaceRepo.findMembers(workspaceId);
    return { members };
  }

  async addMember(workspaceId: string, dto: AddWorkspaceMemberDto) {
    let targetUserId = dto.userId || dto.email;
    if (!targetUserId) {
      throw new BadRequestException('User ID or Email is required');
    }

    if (targetUserId.includes('@')) {
      const user = await this.workspaceRepo.findUserByEmail(targetUserId);
      if (!user) {
        throw new NotFoundException('User with this email was not found');
      }
      targetUserId = user.id;
    }

    const existing = await this.workspaceRepo.findMember(
      workspaceId,
      targetUserId,
    );

    if (existing) {
      throw new BadRequestException(
        'User is already a member of this workspace',
      );
    }

    const member = await this.workspaceRepo.createMember(
      workspaceId,
      targetUserId,
      dto.role || WorkspaceMemberRole.member,
    );

    await Promise.all([
      this.invalidateUserWorkspacesCache(targetUserId),
      this.cache.del(`flux:iam:ws_role:${workspaceId}:${targetUserId}`),
    ]);

    return {
      message: 'Member added successfully',
      member,
    };
  }

  async updateMember(
    workspaceId: string,
    targetUserId: string,
    dto: UpdateWorkspaceMemberDto,
  ) {
    const currentMember = await this.workspaceRepo.findMember(
      workspaceId,
      targetUserId,
    );
    if (!currentMember) {
      throw new NotFoundException('Member not found in this workspace');
    }

    if (
      currentMember.role === WorkspaceMemberRole.owner &&
      dto.role !== WorkspaceMemberRole.owner
    ) {
      const ownerCount = await this.workspaceRepo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot demote the only owner of the workspace. Transfer ownership first.',
        );
      }
    }

    const member = await this.workspaceRepo.updateMemberRole(
      workspaceId,
      targetUserId,
      dto.role,
    );

    await Promise.all([
      this.invalidateUserWorkspacesCache(targetUserId),
      this.cache.del(`flux:iam:ws_role:${workspaceId}:${targetUserId}`),
    ]);

    return {
      message: 'Member role updated successfully',
      member,
    };
  }

  async removeMember(workspaceId: string, targetUserId: string) {
    const member = await this.workspaceRepo.findMember(
      workspaceId,
      targetUserId,
    );
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === WorkspaceMemberRole.owner) {
      const ownerCount = await this.workspaceRepo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot remove the only owner of the workspace. Transfer ownership first.',
        );
      }
    }

    await this.workspaceRepo.deleteMember(workspaceId, targetUserId);

    await Promise.all([
      this.invalidateUserWorkspacesCache(targetUserId),
      this.cache.del(`flux:iam:ws_role:${workspaceId}:${targetUserId}`),
    ]);

    return { message: 'Member removed successfully' };
  }

  async joinByCode(userId: string, inviteCode: string) {
    const workspace = await this.workspaceRepo.findByInviteCode(inviteCode);

    if (!workspace) {
      throw new NotFoundException('Invalid invite code');
    }

    const existing = await this.workspaceRepo.findMember(workspace.id, userId);

    if (!existing) {
      await this.workspaceRepo.createMember(
        workspace.id,
        userId,
        WorkspaceMemberRole.member,
      );
      await this.invalidateUserWorkspacesCache(userId);
    }

    return this.getWorkspace(workspace.id, userId);
  }

  async leaveWorkspace(workspaceId: string, userId: string) {
    const member = await this.workspaceRepo.findMember(workspaceId, userId);
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === WorkspaceMemberRole.owner) {
      const ownerCount = await this.workspaceRepo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot leave workspace as the only owner. Transfer ownership first.',
        );
      }
    }

    await this.workspaceRepo.deleteMember(workspaceId, userId);

    await Promise.all([
      this.invalidateUserWorkspacesCache(userId),
      this.cache.del(`flux:iam:ws_role:${workspaceId}:${userId}`),
    ]);

    return { message: 'Left workspace successfully' };
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

    const invitation = await this.invitationRepo.createInvitation({
      workspaceId,
      email: dto.email,
      role: dto.role || WorkspaceMemberRole.member,
      invitedById,
      expiresInDays: dto.expiresInDays || 7,
    });

    await this.cache.del(WORKSPACE_REDIS_KEYS.pendingInvitations(workspaceId));

    return {
      message: 'Invitation created successfully',
      invitation,
    };
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

    const existingMember = await this.workspaceRepo.findMember(
      invitation.workspaceId,
      userId,
    );

    if (!existingMember) {
      await this.workspaceRepo.createMember(
        invitation.workspaceId,
        userId,
        invitation.role,
      );
    }

    await this.invitationRepo.updateStatus(
      invitation.id,
      'accepted',
      new Date(),
    );

    await Promise.all([
      this.invalidateUserWorkspacesCache(userId),
      this.cache.del(
        WORKSPACE_REDIS_KEYS.pendingInvitations(invitation.workspaceId),
      ),
    ]);

    return {
      message: 'Invitation accepted successfully',
      workspaceId: invitation.workspaceId,
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
    const targetWsId = ws.id;

    if (userId) {
      const isMember = ws.members?.some((m) => m.userId === userId);
      if (!isMember) {
        const member = await this.workspaceRepo.findMember(targetWsId, userId);
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
        this.workspaceRepo.searchProjects(targetWsId, cleanQuery),
        this.workspaceRepo.searchTasks(targetWsId, cleanQuery),
        this.workspaceRepo.searchPapers(targetWsId, cleanQuery),
        this.workspaceRepo.searchPages(targetWsId, cleanQuery),
        this.workspaceRepo.searchFiles(targetWsId, cleanQuery),
        this.workspaceRepo.searchStickies(targetWsId, cleanQuery),
      ],
    );

    const results: SearchResultItem[] = [
      ...projects.map((p) => ({
        type: 'project' as const,
        id: p.id,
        name: p.name,
        icon: p.avatar || null,
        updatedAt: p.updatedAt,
      })),
      ...tasks.map((t) => ({
        type: 'task' as const,
        id: t.id,
        name: t.title,
        identifier: t.identifier,
        projectId: t.projectId,
        projectName: t.project?.name,
        updatedAt: t.updatedAt,
      })),
      ...papers.map((p) => ({
        type: 'paper' as const,
        id: p.id,
        name: p.title,
        updatedAt: p.updatedAt,
      })),
      ...pages.map((p) => ({
        type: 'page' as const,
        id: p.id,
        name: p.title,
        projectId: p.projectId,
        projectName: p.project?.name,
        updatedAt: p.updatedAt,
      })),
      ...files.map((f) => ({
        type: f.isFolder ? ('folder' as const) : ('file' as const),
        id: f.id,
        name: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        updatedAt: f.updatedAt,
      })),
      ...stickies.map((s) => ({
        type: 'sticky' as const,
        id: s.id,
        name: s.title || 'Untitled Sticky',
        color: s.color,
        updatedAt: s.updatedAt,
      })),
    ];

    return results.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
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
    await Promise.all([
      ...keys.map((k) => this.cache.del(k)),
      this.cache.delPattern('flux:ws:user_workspaces:*'),
      this.cache.delPattern('workspaces:*'),
      this.cache.delPattern('dashboard:*'),
    ]);
  }

  private async invalidateUserWorkspacesCache(userId: string) {
    await Promise.all([
      this.cache.del(WORKSPACE_REDIS_KEYS.userWorkspaces(userId)),
      this.cache.delPattern('workspaces:*'),
      this.cache.delPattern('dashboard:*'),
    ]);
  }
}
