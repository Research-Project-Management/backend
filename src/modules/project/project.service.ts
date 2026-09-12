import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectRepository } from './project.repository';
import { Prisma, ProjectMemberRole, EntityType } from '@prisma/client';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item/state/types/state.types';
import { MemberService } from './member/member.service';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { PROJECT_REDIS_KEYS } from './constants/redis-keys.constant';
import { WORK_ITEM_REDIS_KEYS } from '@/modules/work-item/core/constants/redis-keys.constant';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddProjectMemberDto,
  UpdateProjectMemberDto,
} from './dto/project.dto';

const VALID_PROJECT_ROLES = new Set<string>(Object.values(ProjectMemberRole));

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepo: ProjectRepository,
    @Optional() private readonly memberService?: MemberService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateProjectCache(
    projectId: string,
    workspaceId?: string,
  ) {
    if (!this.cache) return;
    await Promise.all([
      this.cache.del(PROJECT_REDIS_KEYS.project(projectId)),
      this.cache.del(PROJECT_REDIS_KEYS.overview(projectId)),
      workspaceId
        ? this.cache.del(PROJECT_REDIS_KEYS.workspaceProjects(workspaceId))
        : Promise.resolve(),
    ]);
  }

  async getProjects(workspaceId: string) {
    const workspace = await this.projectRepo.resolveWorkspace(workspaceId);
    const resolvedWorkspaceId = workspace?.id || workspaceId;
    const cacheKey = PROJECT_REDIS_KEYS.workspaceProjects(resolvedWorkspaceId);

    if (this.cache) {
      return this.cache.wrap(
        cacheKey,
        async () => {
          const projects =
            await this.projectRepo.findWorkspaceProjects(resolvedWorkspaceId);
          return { projects };
        },
        1800,
      );
    }

    const projects =
      await this.projectRepo.findWorkspaceProjects(resolvedWorkspaceId);
    return { projects };
  }

  private async resolveUserRoleInProject(
    project: { workspaceId?: string | null; members?: any[] },
    userId?: string,
  ): Promise<ProjectMemberRole | (string & {})> {
    if (!userId) return ProjectMemberRole.viewer;

    const member = project.members?.find(
      (projectMember: { userId: string; role?: string }) =>
        projectMember.userId === userId,
    );
    if (member?.role) {
      return member.role;
    }

    // Personal workspace model: no workspace-level role fallback.
    // If the user is not a project member, they have no access.
    return ProjectMemberRole.viewer;
  }

  async getProject(projectId: string, userId?: string) {
    const cacheKey = PROJECT_REDIS_KEYS.project(projectId);
    let project = this.cache ? await this.cache.get<any>(cacheKey) : null;

    if (!project) {
      project = await this.projectRepo.findProjectById(projectId);
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      if (this.cache) {
        await this.cache.set(cacheKey, project, 3600);
      }
    }

    const yourRole = await this.resolveUserRoleInProject(project, userId);

    return {
      project,
      yourRole,
    };
  }

  async getProjectOverview(projectId: string, userId?: string) {
    const cacheKey = PROJECT_REDIS_KEYS.overview(projectId);

    const overviewFetch = async () => {
      const overview = await this.projectRepo.findProjectOverview(projectId);
      if (!overview) {
        throw new NotFoundException('Project not found');
      }
      return overview as any;
    };

    const overviewData = this.cache
      ? await this.cache.wrap(cacheKey, overviewFetch, 900)
      : await overviewFetch();

    const targetProject = overviewData.project || overviewData;
    const yourRole = await this.resolveUserRoleInProject(targetProject, userId);

    return {
      ...overviewData,
      yourRole,
    };
  }

  async createProject(
    workspaceId: string,
    userId: string,
    dto: CreateProjectDto,
  ) {
    const inputWorkspaceId = workspaceId || dto.workspaceId;
    if (!inputWorkspaceId) {
      throw new BadRequestException('Workspace ID is required');
    }

    const workspace = await this.projectRepo.resolveWorkspace(inputWorkspaceId);
    const resolvedWorkspaceId = workspace?.id || inputWorkspaceId;

    const identifier = dto.identifier?.trim().toUpperCase();
    if (identifier) {
      const existing = await this.projectRepo.findProjectByIdentifier(
        resolvedWorkspaceId,
        identifier,
      );
      if (existing) {
        throw new BadRequestException(
          `Project with identifier "${identifier}" already exists in this workspace`,
        );
      }
    }

    const project = await this.projectRepo.createProject({
      name: dto.name,
      identifier: identifier || null,
      avatar: dto.avatar || '',
      coverImage: dto.coverImage || dto.cover || '',
      description: dto.description || '',
      modules: dto.modules || [
        'overview',
        'tasks',
        'cycles',
        'pages',
        'storage',
        'stickies',
      ],
      workspace: { connect: { id: resolvedWorkspaceId } },
      createdBy: { connect: { id: userId } },
      taskColumns: DEFAULT_WORK_ITEM_STATES as unknown as Prisma.InputJsonValue,
      ...(dto.leadId ? { lead: { connect: { id: dto.leadId } } } : {}),
      members: {
        create: {
          userId,
          role: ProjectMemberRole.owner, // Creator becomes project owner (PI/team lead)
        },
      },
    });

    await this.invalidateProjectCache(project.id, resolvedWorkspaceId);

    this.eventEmitter?.emit(
      'project.created',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: project.id,
        verb: 'created',
        actorId: userId,
        workspaceId: project.workspaceId,
        projectId: project.id,
      }),
    );

    return { project };
  }

  async updateProject(projectId: string, dto: UpdateProjectDto) {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }

    if (dto.identifier !== undefined && dto.identifier) {
      const identifier = dto.identifier.trim().toUpperCase();
      const duplicate = await this.projectRepo.findProjectByIdentifier(
        existing.workspaceId,
        identifier,
      );
      if (duplicate && duplicate.id !== projectId) {
        throw new BadRequestException(
          `Project with identifier "${identifier}" already exists in this workspace`,
        );
      }
      dto.identifier = identifier;
    }

    const coverVal = dto.coverImage !== undefined ? dto.coverImage : dto.cover;
    const activeVal =
      dto.isActive !== undefined
        ? dto.isActive
        : dto.isArchived !== undefined
          ? !dto.isArchived
          : undefined;

    const project = await this.projectRepo.updateProject(projectId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.identifier !== undefined && { identifier: dto.identifier }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(coverVal !== undefined && { coverImage: coverVal }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.modules !== undefined && { modules: dto.modules }),
      ...(activeVal !== undefined && { isActive: activeVal }),
      ...(dto.settings !== undefined && { settings: dto.settings }),
      ...(dto.leadId !== undefined && {
        lead: dto.leadId
          ? { connect: { id: dto.leadId } }
          : { disconnect: true },
      }),
    });

    await this.invalidateProjectCache(projectId, existing.workspaceId);

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: project.id,
        verb: 'updated',
        actorId: '',
        workspaceId: project.workspaceId,
        projectId: project.id,
      }),
    );

    return { project };
  }

  async deleteProject(projectId: string) {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }

    await this.projectRepo.softDeleteProject(projectId);
    await this.invalidateProjectCache(projectId, existing.workspaceId);

    this.eventEmitter?.emit(
      'project.deleted',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'deleted',
        actorId: '',
        workspaceId: existing.workspaceId,
        projectId: projectId,
      }),
    );

    return { message: 'Project soft-deleted successfully' };
  }

  async restoreProject(projectId: string) {
    const restored = await this.projectRepo.restoreProject(projectId);
    await this.invalidateProjectCache(projectId, restored.workspaceId);
    return {
      message: 'Project restored successfully',
      project: restored,
    };
  }

  async archiveProject(projectId: string, userId?: string) {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }
    if (!existing.isActive) {
      throw new BadRequestException('Project is already archived');
    }

    const archived = await this.projectRepo.archiveProject(projectId);
    await this.invalidateProjectCache(projectId, existing.workspaceId);

    this.eventEmitter?.emit(
      'project.archived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'archived',
        actorId: userId || '',
        workspaceId: existing.workspaceId,
        projectId: projectId,
      }),
    );

    return {
      message: 'Project archived successfully',
      project: archived,
    };
  }

  async unarchiveProject(projectId: string, userId?: string) {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }
    if (existing.isActive) {
      throw new BadRequestException('Project is not archived');
    }

    const restored = await this.projectRepo.unarchiveProject(projectId);
    await this.invalidateProjectCache(projectId, existing.workspaceId);

    this.eventEmitter?.emit(
      'project.unarchived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'restored',
        actorId: userId || '',
        workspaceId: existing.workspaceId,
        projectId: projectId,
      }),
    );

    return {
      message: 'Project restored from archive successfully',
      project: restored,
    };
  }

  async getArchivedProjects(workspaceId: string) {
    const workspace = await this.projectRepo.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId = workspace?.id || workspaceId;
    const projects =
      await this.projectRepo.findWorkspaceArchivedProjects(canonicalWorkspaceId);
    return { projects };
  }

  async getProjectMembers(projectId: string) {
    if (this.memberService) {
      return this.memberService.getMembers(projectId);
    }
    const members = await this.projectRepo.findProjectMembers(projectId);
    return { members };
  }

  async addProjectMember(projectId: string, dto: AddProjectMemberDto) {
    if (this.memberService) {
      return this.memberService.addMember(projectId, dto);
    }
    const existing = await this.projectRepo.findProjectMember(
      projectId,
      dto.userId,
    );

    if (existing) {
      throw new BadRequestException('User is already a member of this project');
    }

    const role = dto.role || ProjectMemberRole.contributor;
    if (!VALID_PROJECT_ROLES.has(role)) {
      throw new BadRequestException(
        `Invalid project role "${role}". Valid roles are: ${Object.values(ProjectMemberRole).join(', ')}`,
      );
    }

    // Personal workspace model: any registered user can be invited to a project.
    // There is no workspace membership prerequisite.
    // Prevent inviting someone as 'owner' — ownership is set at project creation only.
    if (role === ProjectMemberRole.owner) {
      throw new ForbiddenException(
        'Cannot invite a user as project owner. Use transfer ownership instead.',
      );
    }

    const member = await this.projectRepo.createProjectMember(
      projectId,
      dto.userId,
      role,
    );

    await this.invalidateProjectCache(projectId);
    if (this.cache) {
      await this.cache.del(`flux:iam:proj_role:${projectId}:${dto.userId}`);
    }

    return {
      message: 'Project member added successfully',
      member,
    };
  }

  async updateProjectMember(
    projectId: string,
    targetUserId: string,
    dto: UpdateProjectMemberDto,
  ) {
    if (this.memberService && dto.role) {
      return this.memberService.updateMemberRole(projectId, targetUserId, {
        role: dto.role,
      });
    }
    const role = dto.role;
    if (!role || !VALID_PROJECT_ROLES.has(role)) {
      throw new BadRequestException(
        `Invalid project role "${dto.role}". Valid roles are: ${Object.values(ProjectMemberRole).join(', ')}`,
      );
    }

    const existing = await this.projectRepo.findProjectMember(
      projectId,
      targetUserId,
    );
    if (!existing) {
      throw new NotFoundException('Project member not found');
    }

    const project = await this.projectRepo.findProjectById(projectId);
    if (project) {
      const wsRole = await this.projectRepo.findWorkspaceMemberRole(
        project.workspaceId,
        targetUserId,
      );
      if (
        wsRole === 'viewer' &&
        (role === ProjectMemberRole.admin ||
          role === ProjectMemberRole.contributor)
      ) {
        throw new ForbiddenException(
          'Workspace viewers cannot be granted contributor or admin roles in projects',
        );
      }
    }

    // Single Admin Invariant check
    if (
      existing.role === ProjectMemberRole.admin &&
      role !== ProjectMemberRole.admin
    ) {
      const adminCount = await this.projectRepo.countAdmins(projectId);
      if (adminCount <= 1) {
        throw new ForbiddenException(
          'Cannot demote the only admin of the project. Assign another admin first.',
        );
      }
    }

    const member = await this.projectRepo.updateProjectMemberRole(
      projectId,
      targetUserId,
      role,
    );

    await this.invalidateProjectCache(projectId);
    if (this.cache) {
      await this.cache.del(`flux:iam:proj_role:${projectId}:${targetUserId}`);
    }

    return {
      message: 'Project member role updated successfully',
      member,
    };
  }

  async removeProjectMember(projectId: string, targetUserId: string) {
    if (this.memberService) {
      return this.memberService.removeMember(projectId, targetUserId);
    }
    const existing = await this.projectRepo.findProjectMember(
      projectId,
      targetUserId,
    );
    if (!existing) {
      throw new NotFoundException('Project member not found');
    }

    if (existing.role === ProjectMemberRole.admin) {
      const adminCount = await this.projectRepo.countAdmins(projectId);
      if (adminCount <= 1) {
        throw new ForbiddenException(
          'Cannot remove the only admin of the project. Assign another admin first.',
        );
      }
    }

    await this.projectRepo.deleteProjectMember(projectId, targetUserId);
    await this.invalidateProjectCache(projectId);
    if (this.cache) {
      await this.cache.del(`flux:iam:proj_role:${projectId}:${targetUserId}`);
    }

    return { message: 'Project member removed successfully' };
  }

  async leaveProject(projectId: string, userId: string) {
    if (this.memberService) {
      return this.memberService.leaveProject(projectId, userId);
    }
    return this.removeProjectMember(projectId, userId);
  }
}
