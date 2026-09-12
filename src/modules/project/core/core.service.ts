import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CoreRepository } from './core.repository';
import { ProjectMemberRole, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CACHE_KEYS, CACHE_TTL_SECONDS } from './constants/cache.constant';
import { CreateProjectDto } from './dto/create.dto';
import { UpdateProjectDto } from './dto/update.dto';
import { ProjectQueryDto } from './dto/query.dto';
import {
  ProjectWithMembers,
  ProjectOverview,
  AllocatedIdentifier,
} from './types/project.type';
import { deriveProjectPrefix } from './utils/identifier.util';

@Injectable()
export class CoreService {
  constructor(
    private readonly projectRepo: CoreRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  private async invalidateProjectCache(
    projectId: string,
    affectedUserIds: string[] = [],
  ): Promise<void> {
    if (!this.cache) return;
    try {
      const keys = [
        CACHE_KEYS.detail(projectId),
        CACHE_KEYS.overview(projectId),
        ...affectedUserIds.map((uid) => CACHE_KEYS.userProjects(uid)),
      ];
      await Promise.all(keys.map((k) => this.cache!.del(k)));
    } catch {
      // Best effort cache invalidation
    }
  }

  private resolveUserRoleInProject(
    project: { members?: Array<{ userId: string; role?: string }> } | null,
    userId?: string,
  ): ProjectMemberRole | string {
    if (!userId || !project?.members) return ProjectMemberRole.viewer;

    const member = project.members.find((m) => m.userId === userId);
    return member?.role || ProjectMemberRole.viewer;
  }

  /**
   * Find all projects for a user with optional filter ('created' | 'shared' | 'all') and search.
   */
  async findUserProjects(
    userId: string,
    query?: ProjectQueryDto,
  ): Promise<{
    projects: ProjectWithMembers[];
    myProjects: ProjectWithMembers[];
    sharedProjects: ProjectWithMembers[];
    total: number;
  }> {
    const filter = query?.type || 'all';
    let projects = await this.projectRepo.findProjectsByUser(userId, filter);

    if (query?.search?.trim()) {
      const s = query.search.trim().toLowerCase();
      projects = projects.filter(
        (p) =>
          p.name.toLowerCase().includes(s) ||
          p.identifier?.toLowerCase().includes(s) ||
          p.description?.toLowerCase().includes(s),
      );
    }

    const myProjects = projects.filter((p) => p.createdById === userId);
    const sharedProjects = projects.filter((p) => p.createdById !== userId);

    return {
      projects,
      myProjects,
      sharedProjects,
      total: projects.length,
    };
  }

  /**
   * Find a single project by ID or identifier with Redis caching.
   */
  async findById(
    projectId: string,
    userId?: string,
  ): Promise<{
    project: ProjectWithMembers;
    yourRole: ProjectMemberRole | string;
  }> {
    const cacheKey = CACHE_KEYS.detail(projectId);
    let project = this.cache
      ? await this.cache.get<ProjectWithMembers>(cacheKey)
      : null;

    if (!project) {
      project = await this.projectRepo.findProjectById(projectId);
      if (!project) {
        throw new NotFoundException('Project not found');
      }
      if (this.cache) {
        await this.cache.set(cacheKey, project, CACHE_TTL_SECONDS.DETAIL);
      }
    }

    const yourRole = this.resolveUserRoleInProject(project, userId);

    return {
      project,
      yourRole,
    };
  }

  /**
   * Find project dashboard overview statistics with Redis caching.
   */
  async findOverview(
    projectId: string,
    userId?: string,
  ): Promise<{
    overview: ProjectOverview;
    yourRole: ProjectMemberRole | string;
  }> {
    const cacheKey = CACHE_KEYS.overview(projectId);

    const overviewFetch = async (): Promise<ProjectOverview> => {
      const overview = await this.projectRepo.findProjectOverview(projectId);
      if (!overview) {
        throw new NotFoundException('Project not found');
      }
      return overview;
    };

    const overview = this.cache
      ? await this.cache.wrap(
          cacheKey,
          overviewFetch,
          CACHE_TTL_SECONDS.OVERVIEW,
        )
      : await overviewFetch();

    const project = await this.projectRepo.findProjectById(projectId);
    const yourRole = this.resolveUserRoleInProject(project, userId);

    return {
      overview,
      yourRole,
    };
  }

  /**
   * Create a new project. The caller becomes project 'owner'.
   */
  async create(
    userId: string,
    dto: CreateProjectDto,
  ): Promise<{ project: ProjectWithMembers }> {
    const identifier = dto.identifier?.trim().toUpperCase();
    if (identifier) {
      const existing =
        await this.projectRepo.findProjectByIdentifier(identifier);
      if (existing) {
        throw new BadRequestException(
          `Project with identifier "${identifier}" already exists`,
        );
      }
    }

    const project = await this.projectRepo.createProject(userId, {
      name: dto.name,
      identifier: identifier || null,
      avatar: dto.avatar || '',
      coverImage: dto.coverImage || dto.cover || '',
      description: dto.description || '',
      modules: dto.modules,
    });

    await this.invalidateProjectCache(project.id, [userId]);

    this.eventEmitter?.emit(
      'project.created',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: project.id,
        verb: 'created',
        actorId: userId,
        projectId: project.id,
      }),
    );

    return { project };
  }

  /**
   * Update an existing project.
   */
  async update(
    projectId: string,
    dto: UpdateProjectDto,
    actorId?: string,
  ): Promise<{ project: ProjectWithMembers }> {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }

    if (dto.identifier !== undefined && dto.identifier) {
      const identifier = dto.identifier.trim().toUpperCase();
      const duplicate =
        await this.projectRepo.findProjectByIdentifier(identifier);
      if (duplicate && duplicate.id !== projectId) {
        throw new BadRequestException(
          `Project with identifier "${identifier}" already exists`,
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
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.identifier !== undefined && { identifier: dto.identifier }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(coverVal !== undefined && { coverImage: coverVal }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.modules !== undefined && { modules: dto.modules }),
      ...(activeVal !== undefined && { isActive: activeVal }),
      ...(dto.settings !== undefined && {
        settings: dto.settings as any,
      }),
    });

    const memberIds = project.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: project.id,
        verb: 'updated',
        actorId: actorId || '',
        projectId: project.id,
      }),
    );

    return { project };
  }

  /**
   * Soft-delete a project.
   */
  async softDelete(
    projectId: string,
    actorId?: string,
  ): Promise<{ message: string }> {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }

    await this.projectRepo.softDeleteProject(projectId);
    const memberIds = existing.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.deleted',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'deleted',
        actorId: actorId || '',
        projectId,
      }),
    );

    return { message: 'Project soft-deleted successfully' };
  }

  /**
   * Restore a soft-deleted project.
   */
  async restore(
    projectId: string,
    actorId?: string,
  ): Promise<{
    message: string;
    project: ProjectWithMembers;
  }> {
    const restored = await this.projectRepo.restoreProject(projectId);
    const memberIds = restored.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.restored',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'restored',
        actorId: actorId || '',
        projectId,
      }),
    );

    return {
      message: 'Project restored successfully',
      project: restored,
    };
  }

  /**
   * Archive a project (freeze & hide from active project lists).
   */
  async archive(
    projectId: string,
    userId?: string,
  ): Promise<{
    message: string;
    project: ProjectWithMembers;
  }> {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }
    if (!existing.isActive) {
      throw new BadRequestException('Project is already archived');
    }

    const archived = await this.projectRepo.archiveProject(projectId);
    const memberIds = archived.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.archived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'archived',
        actorId: userId || '',
        projectId,
      }),
    );

    return {
      message: 'Project archived successfully',
      project: archived,
    };
  }

  /**
   * Unarchive/restore an archived project to active status.
   */
  async unarchive(
    projectId: string,
    userId?: string,
  ): Promise<{
    message: string;
    project: ProjectWithMembers;
  }> {
    const existing = await this.projectRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException('Project not found');
    }
    if (existing.isActive) {
      throw new BadRequestException('Project is not archived');
    }

    const restored = await this.projectRepo.unarchiveProject(projectId);
    const memberIds = restored.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.unarchived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'restored',
        actorId: userId || '',
        projectId,
      }),
    );

    return {
      message: 'Project restored from archive successfully',
      project: restored,
    };
  }

  /**
   * Find archived projects accessible by a user.
   */
  async findArchived(
    userId: string,
  ): Promise<{ projects: ProjectWithMembers[] }> {
    const projects = await this.projectRepo.findArchivedProjectsByUser(userId);
    return { projects };
  }

  // --- Facade / Gateway methods for other modules ---

  /**
   * Asserts that a project exists and is active, returning its entity or throwing NotFoundException.
   */
  async assertProjectExists(projectId: string): Promise<ProjectWithMembers> {
    const project = await this.projectRepo.findProjectById(projectId);
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
    return project;
  }

  /**
   * Checks whether a given user is enrolled as an active member of the project.
   */
  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    return this.projectRepo.isProjectMember(projectId, userId);
  }

  /**
   * Retrieves configuration/settings JSON for a project.
   */
  async getProjectSettings(
    projectId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.projectRepo.getProjectSettings(projectId);
  }

  /**
   * Allocates the next sequential human-readable WorkItem identifier (e.g. 'BIO-42').
   */
  async allocateTaskIdentifier(
    projectId: string,
  ): Promise<AllocatedIdentifier> {
    return this.projectRepo.allocateTaskIdentifier(projectId);
  }

  /**
   * Gets the short prefix code for tasks in this project (e.g. 'BIO').
   */
  async getProjectPrefix(projectId: string): Promise<string> {
    const project = await this.assertProjectExists(projectId);
    return deriveProjectPrefix(project.identifier, project.name);
  }
}

export { CoreService as ProjectService };
