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
import { parseTaskColumns, TaskColumn } from './types/project.types';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { PROJECT_REDIS_KEYS } from './constants/redis-keys.constant';
import { WORK_ITEM_REDIS_KEYS } from '@/modules/work-item/constants/redis-keys.constant';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddProjectMemberDto,
  UpdateProjectMemberDto,
  AddColumnDto,
  UpdateColumnDto,
} from './dto/project.dto';

const VALID_PROJECT_ROLES = new Set<string>(Object.values(ProjectMemberRole));

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepo: ProjectRepository,
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

    const member = userId
      ? project.members?.find(
          (projectMember: { userId: string }) =>
            projectMember.userId === userId,
        )
      : undefined;

    return {
      project,
      yourRole: member?.role || ProjectMemberRole.viewer,
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

    const member = userId
      ? overviewData.project?.members?.find(
          (projectMember: { userId: string }) =>
            projectMember.userId === userId,
        )
      : undefined;

    return {
      ...overviewData,
      yourRole: member?.role || ProjectMemberRole.viewer,
    };
  }

  async createProject(
    workspaceId: string,
    userId: string,
    dto: CreateProjectDto,
  ) {
    const targetWorkspaceId = workspaceId || dto.workspaceId;
    if (!targetWorkspaceId) {
      throw new BadRequestException('Workspace ID is required');
    }

    const workspace =
      await this.projectRepo.resolveWorkspace(targetWorkspaceId);
    const resolvedWorkspaceId = workspace?.id || targetWorkspaceId;

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
      coverImage: dto.coverImage || '',
      description: dto.description || '',
      modules: dto.modules || [
        'overview',
        'tasks',
        'cycles',
        'pages',
        'storage',
        'stickies',
        'collection',
      ],
      workspace: { connect: { id: resolvedWorkspaceId } },
      createdBy: { connect: { id: userId } },
      ...(dto.leadId ? { lead: { connect: { id: dto.leadId } } } : {}),
      members: {
        create: {
          userId,
          role: ProjectMemberRole.admin,
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

    const project = await this.projectRepo.updateProject(projectId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.identifier !== undefined && { identifier: dto.identifier }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(dto.coverImage !== undefined && { coverImage: dto.coverImage }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.modules !== undefined && { modules: dto.modules }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
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

  async getProjectMembers(projectId: string) {
    const members = await this.projectRepo.findProjectMembers(projectId);
    return { members };
  }

  async addProjectMember(projectId: string, dto: AddProjectMemberDto) {
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
    if (!VALID_PROJECT_ROLES.has(dto.role)) {
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

    // Single Admin Invariant check
    if (
      existing.role === ProjectMemberRole.admin &&
      dto.role !== ProjectMemberRole.admin
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
      dto.role,
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
    return this.removeProjectMember(projectId, userId);
  }

  async getColumns(projectId: string) {
    const project = await this.projectRepo.findProjectById(projectId);
    if (!project) throw new NotFoundException('Project not found');
    return { columns: parseTaskColumns(project.taskColumns) };
  }

  async addColumn(projectId: string, dto: AddColumnDto) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    const newColumn: TaskColumn = {
      id: dto.id || dto.title.toLowerCase().replace(/\s+/g, '-'),
      title: dto.title,
      isDefault: false,
      accentColor: dto.accentColor || '#6366F1',
    };

    const updatedColumns = [...columns, newColumn];

    await this.projectRepo.updateProject(projectId, {
      taskColumns: updatedColumns as unknown as Prisma.InputJsonValue,
    });

    await this.invalidateProjectCache(projectId, project.workspaceId);

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'updated',
        actorId: '',
        workspaceId: project.workspaceId,
        projectId,
      }),
    );

    return { columns: updatedColumns };
  }

  async updateColumn(
    projectId: string,
    columnId: string,
    dto: UpdateColumnDto,
  ) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    const updatedColumns = columns.map((col) => {
      if (col.id === columnId) {
        return {
          ...col,
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.accentColor !== undefined && {
            accentColor: dto.accentColor,
          }),
        };
      }
      return col;
    });

    await this.projectRepo.updateProject(projectId, {
      taskColumns: updatedColumns as unknown as Prisma.InputJsonValue,
    });

    await this.invalidateProjectCache(projectId, project.workspaceId);

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'updated',
        actorId: '',
        workspaceId: project.workspaceId,
        projectId,
      }),
    );

    return { columns: updatedColumns };
  }

  async deleteColumn(
    projectId: string,
    columnId: string,
    fallbackColumnId?: string,
    userId?: string,
  ) {
    const project = await this.projectRepo.findProjectById(projectId);

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const columns = parseTaskColumns(project.taskColumns);
    if (columns.length <= 1) {
      throw new BadRequestException('Project must have at least one column');
    }

    const updatedColumns = columns.filter((col) => col.id !== columnId);
    const targetFallback =
      fallbackColumnId &&
      updatedColumns.some((col) => col.id === fallbackColumnId)
        ? fallbackColumnId
        : updatedColumns[0].id;

    await this.projectRepo.deleteColumnWithTaskMigration(
      projectId,
      columnId,
      targetFallback,
      updatedColumns as unknown as Prisma.InputJsonValue,
    );

    await this.invalidateProjectCache(projectId, project.workspaceId);
    if (this.cache) {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
        this.cache.del(`flux:proj:overview:${projectId}`),
      ]);
    }

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'updated',
        actorId: userId || '',
        workspaceId: project.workspaceId,
        projectId,
      }),
    );

    return { columns: updatedColumns, migratedTo: targetFallback };
  }
}
