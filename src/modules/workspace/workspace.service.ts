import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { WorkspaceRepository } from './workspace.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  AddWorkspaceMemberDto,
  UpdateWorkspaceMemberDto,
} from './dto/workspace.dto';
import { SearchResultItem } from './dto/search-result.dto';
import * as crypto from 'crypto';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly cache: RedisCacheService,
  ) {}

  async getMyWorkspaces(userId: string) {
    return this.cache.wrap(
      `workspaces:user:${userId}`,
      async () => {
        const workspaces = await this.workspaceRepo.findUserWorkspaces(userId);
        return { workspaces };
      },
      120,
    );
  }

  async getWorkspace(workspaceIdOrUrl: string, userId: string) {
    const workspace =
      await this.workspaceRepo.findWorkspaceByIdOrUrl(workspaceIdOrUrl);

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    const member = workspace.members.find((m) => m.userId === userId);
    return {
      workspace,
      yourRole: member?.role || 'member',
    };
  }

  async createWorkspace(userId: string, dto: CreateWorkspaceDto) {
    const existing = await this.workspaceRepo.findWorkspaceByUrl(dto.url);

    if (existing) {
      throw new BadRequestException('Workspace URL is already taken');
    }

    const inviteCode = crypto.randomBytes(4).toString('hex');
    const workspace = await this.workspaceRepo.createWorkspace({
      name: dto.name,
      url: dto.url,
      avatar: dto.avatar || '',
      companySize: dto.companySize || '',
      inviteCode,
      createdById: userId,
      members: {
        create: {
          userId,
          role: 'owner',
        },
      },
    });

    await Promise.all([
      this.cache.delPattern('workspaces:*'),
      this.cache.delPattern('dashboard:*'),
    ]);

    return { workspace };
  }

  async updateWorkspace(workspaceId: string, dto: UpdateWorkspaceDto) {
    const workspace = await this.workspaceRepo.updateWorkspace(workspaceId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.url !== undefined && { url: dto.url }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(dto.companySize !== undefined && { companySize: dto.companySize }),
    });

    await Promise.all([
      this.cache.delPattern('workspaces:*'),
      this.cache.delPattern('dashboard:*'),
    ]);

    return { workspace };
  }

  async deleteWorkspace(workspaceId: string) {
    await this.workspaceRepo.deleteWorkspace(workspaceId);

    await Promise.all([
      this.cache.delPattern('workspaces:*'),
      this.cache.delPattern('dashboard:*'),
    ]);

    return { message: 'Workspace deleted successfully' };
  }

  async getMembers(workspaceId: string) {
    const members = await this.workspaceRepo.findMembers(workspaceId);
    return { members };
  }

  async addMember(workspaceId: string, dto: AddWorkspaceMemberDto) {
    let targetUserId = dto.userId;

    if (dto.userId.includes('@')) {
      const user = await this.workspaceRepo.findUserByEmail(dto.userId);
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
      dto.role || 'member',
    );

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
    const member = await this.workspaceRepo.updateMemberRole(
      workspaceId,
      targetUserId,
      dto.role,
    );

    return {
      message: 'Member role updated successfully',
      member,
    };
  }

  async removeMember(workspaceId: string, targetUserId: string) {
    await this.workspaceRepo.deleteMember(workspaceId, targetUserId);
    return { message: 'Member removed successfully' };
  }

  async joinByCode(userId: string, inviteCode: string) {
    const workspace =
      await this.workspaceRepo.findWorkspaceByInviteCode(inviteCode);

    if (!workspace) {
      throw new NotFoundException('Invalid invite code');
    }

    const existing = await this.workspaceRepo.findMember(workspace.id, userId);

    if (!existing) {
      await this.workspaceRepo.createMember(workspace.id, userId, 'member');
    }

    return this.getWorkspace(workspace.id, userId);
  }

  async leaveWorkspace(workspaceId: string, userId: string) {
    const member = await this.workspaceRepo.findMember(workspaceId, userId);

    if (member?.role === 'owner') {
      const ownerCount = await this.workspaceRepo.countOwners(workspaceId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot leave workspace as the only owner. Transfer ownership first.',
        );
      }
    }

    await this.workspaceRepo.deleteMember(workspaceId, userId);
    return { message: 'Left workspace successfully' };
  }

  async search(
    workspaceId: string,
    query: string,
    _userId?: string,
  ): Promise<SearchResultItem[]> {
    if (!query || !query.trim()) return [];

    const cleanQuery = query.trim();

    const [projects, tasks, papers, pages, files, stickies] = await Promise.all(
      [
        this.workspaceRepo.searchProjects(workspaceId, cleanQuery),
        this.workspaceRepo.searchTasks(workspaceId, cleanQuery),
        this.workspaceRepo.searchPapers(workspaceId, cleanQuery),
        this.workspaceRepo.searchPages(workspaceId, cleanQuery),
        this.workspaceRepo.searchFiles(workspaceId, cleanQuery),
        this.workspaceRepo.searchStickies(workspaceId, cleanQuery),
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
}
