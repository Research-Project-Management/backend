import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CoreRepository } from './core.repository';
import { Role, EntityType, Prisma } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core';
import { CACHE_KEYS, CACHE_TTL_SECONDS } from './constants/cache.constant';
import { CreateProjectDto } from './dto/create.dto';
import { UpdateProjectDto } from './dto/update.dto';
import { ProjectQueryDto } from './dto/query.dto';
import {
  ProjectWithMembers,
  EnrichedProject,
  ProjectOverview,
  AllocatedIdentifier,
  ProjectPermissions,
} from './types/project.type';
import { calculateProjectPermissions } from './utils/permission.util';
import { FavoriteService } from '../favorite/favorite.service';
import { LabelService } from '../label/label.service';
import { ArchiveService } from '../archive/archive.service';
import { deriveProjectPrefix } from './utils/identifier.util';

export const ALLOWED_PROJECT_MODULES = new Set([
  'overview',
  'work-items',
  'pages',
]);

export function sanitizeModules(modules?: string[]): string[] {
  if (!modules || !Array.isArray(modules) || modules.length === 0) {
    return ['overview', 'work-items', 'pages'];
  }
  const filtered = Array.from(
    new Set(
      modules
        .map((m) =>
          String(m).trim().toLowerCase() === 'work_items'
            ? 'work-items'
            : String(m).trim().toLowerCase(),
        )
        .filter((m) => ALLOWED_PROJECT_MODULES.has(m)),
    ),
  );
  return filtered.length > 0 ? filtered : ['overview', 'work-items', 'pages'];
}

@Injectable()
export class CoreService {
  constructor(
    private readonly projectRepo: CoreRepository,
    private readonly favoriteService: FavoriteService,
    private readonly labelService: LabelService,
    @Optional() private readonly archiveService?: ArchiveService,
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
    project: {
      createdById?: string;
      members?: Array<{ userId: string; role?: string }>;
    } | null,
    userId?: string,
  ): Role {
    if (!userId || !project) return Role.reviewer;
    if (project.createdById === userId) return Role.owner;

    const member = project.members?.find((m) => m.userId === userId);
    return (member?.role as Role) || Role.reviewer;
  }

  /**
   * Find all projects for a user with rich filters (state, priority, label, archive, favorite, search).
   */
  async findUserProjects(
    userId: string,
    query?: ProjectQueryDto,
  ): Promise<{
    projects: EnrichedProject[];
    myProjects: EnrichedProject[];
    sharedProjects: EnrichedProject[];
    total: number;
  }> {
    let projects = await this.projectRepo.findProjectsByUser(userId, query);

    if (query?.search?.trim()) {
      const s = query.search.trim().toLowerCase();
      projects = projects.filter(
        (p) =>
          p.name.toLowerCase().includes(s) ||
          p.identifier?.toLowerCase().includes(s) ||
          p.description?.toLowerCase().includes(s),
      );
    }

    // Batch check favorites for this user
    const favoriteSet = await this.favoriteService.batchCheckFavorites(
      projects.map((p) => p.id),
      userId,
    );

    // Apply favorite filter if requested
    if (query?.isFavorite !== undefined) {
      projects = projects.filter((p) =>
        query.isFavorite ? favoriteSet.has(p.id) : !favoriteSet.has(p.id),
      );
    }

    // Resolve user roles for shared projects in a single batch query
    const sharedProjectIds = projects
      .filter((p) => p.createdById !== userId)
      .map((p) => p.id);

    const membershipMap = await this.projectRepo.findMembershipsForUser(
      sharedProjectIds,
      userId,
    );

    const enrichProject = (p: ProjectWithMembers): EnrichedProject => {
      const yourRole =
        p.createdById === userId
          ? Role.owner
          : membershipMap.get(p.id) ||
            p.members?.find((m) => m.userId === userId)?.role ||
            Role.reviewer;
      const permissions = calculateProjectPermissions(yourRole, p.isActive);

      return {
        ...p,
        yourRole,
        permissions,
        isFavorite: favoriteSet.has(p.id),
        projectLabelsList: p.labels?.map((l) => l.label) || [],
      };
    };

    const enrichedProjects = projects.map(enrichProject);
    const myProjects = enrichedProjects.filter((p) => p.createdById === userId);
    const sharedProjects = enrichedProjects.filter(
      (p) => p.createdById !== userId,
    );

    return {
      projects: enrichedProjects,
      myProjects,
      sharedProjects,
      total: enrichedProjects.length,
    };
  }

  /**
   * Find single project by ID with enriched roles, permissions, and favorites.
   */
  async findById(
    projectId: string,
    userId: string,
  ): Promise<{
    project: EnrichedProject;
    yourRole: Role;
    permissions: ProjectPermissions;
  }> {
    const cacheKey = CACHE_KEYS.detail(projectId);

    const projectFetch = async (): Promise<ProjectWithMembers> => {
      const proj = await this.projectRepo.findProjectById(projectId);
      if (!proj) {
        throw new NotFoundException('Project not found');
      }
      return proj;
    };

    const project = this.cache
      ? await this.cache.wrap(cacheKey, projectFetch, CACHE_TTL_SECONDS.DETAIL)
      : await projectFetch();

    const isFavorite = await this.favoriteService.isProjectFavorite(
      projectId,
      userId,
    );
    const yourRole = this.resolveUserRoleInProject(project, userId);
    const permissions = calculateProjectPermissions(yourRole, project.isActive);

    return {
      project: {
        ...project,
        yourRole,
        permissions,
        isFavorite,
        projectLabelsList: project.labels?.map((l) => l.label) || [],
      },
      yourRole,
      permissions,
    };
  }

  /**
   * Find project dashboard overview metrics.
   */
  async findOverview(
    projectId: string,
    userId: string,
  ): Promise<{
    overview: ProjectOverview;
    yourRole: Role;
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
    // Progressive Gating: Unverified users can create at most 1 sandbox project
    const userMeta =
      await this.projectRepo.getUserStatusAndOwnedProjectCount(userId);
    if (
      userMeta &&
      userMeta.status === 'pending_verification' &&
      userMeta.ownedProjectCount >= 1
    ) {
      throw new ForbiddenException({
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message:
          'Please verify your email address to create additional projects. Unverified accounts are limited to 1 sandbox project.',
      });
    }

    const rawIdentifier = dto.identifier?.trim().toUpperCase();
    const desiredIdentifier = (
      rawIdentifier || deriveProjectPrefix(null, dto.name)
    )
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^A-Z0-9_-]/g, '')
      .slice(0, 10) || 'PROJ';

    const isTaken = await this.projectRepo.isIdentifierTaken(
      desiredIdentifier,
      userId,
    );
    if (isTaken) {
      throw new BadRequestException(
        `A project with identifier "${desiredIdentifier}" already exists in your workspace.`,
      );
    }

    const identifier = desiredIdentifier;

    const project = await this.projectRepo.createProject(userId, {
      name: dto.name,
      identifier,
      avatar: dto.avatar || '',
      coverImage: dto.coverImage || dto.cover || '',
      description: dto.description || '',
      stateId: dto.stateId,
      priority: dto.priority,
      startDate: dto.startDate ? new Date(dto.startDate) : null,
      targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
      labelIds: dto.labelIds,
      templateId: dto.templateId || null,
      modules: sanitizeModules(dto.modules),
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
        await this.projectRepo.findProjectByIdentifier(
          identifier,
          existing.createdById,
        );
      if (duplicate && duplicate.id !== projectId) {
        throw new BadRequestException(
          `Project with identifier "${identifier}" already exists`,
        );
      }
      dto.identifier = identifier;
    }

    const coverVal = dto.coverImage !== undefined ? dto.coverImage : dto.cover;

    // Handle label assignments replacement if provided
    if (dto.labelIds !== undefined) {
      await this.labelService.replaceProjectLabels(
        projectId,
        dto.labelIds,
        actorId,
      );
    }

    const project = await this.projectRepo.updateProject(projectId, {
      ...(dto.name !== undefined && { name: dto.name.trim() }),
      ...(dto.identifier !== undefined && { identifier: dto.identifier }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
      ...(coverVal !== undefined && { coverImage: coverVal }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.priority !== undefined && { priority: dto.priority }),
      ...(dto.startDate !== undefined && {
        startDate: dto.startDate ? new Date(dto.startDate) : null,
      }),
      ...(dto.targetDate !== undefined && {
        targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
      }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      ...(dto.isArchived !== undefined && {
        isArchived: dto.isArchived,
        archivedAt: dto.isArchived ? new Date() : null,
      }),
      ...(dto.modules !== undefined && {
        modules: sanitizeModules(dto.modules),
      }),
      ...(dto.settings !== undefined && {
        settings: dto.settings as Prisma.InputJsonValue,
      }),
    });

    if (dto.isFavorite !== undefined && actorId) {
      if (dto.isFavorite) {
        await this.favoriteService.addFavorite(projectId, actorId);
      } else {
        await this.favoriteService.removeFavorite(projectId, actorId);
      }
    }

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
   * Archive a project (delegates to ArchiveService).
   */
  async archive(
    projectId: string,
    userId?: string,
  ): Promise<{
    message: string;
    project: ProjectWithMembers;
  }> {
    if (!this.archiveService) {
      throw new NotFoundException('ArchiveService is not available');
    }
    return this.archiveService.archive(projectId, userId);
  }

  /**
   * Unarchive/restore an archived project to active status (delegates to ArchiveService).
   */
  async unarchive(
    projectId: string,
    userId?: string,
  ): Promise<{
    message: string;
    project: ProjectWithMembers;
  }> {
    if (!this.archiveService) {
      throw new NotFoundException('ArchiveService is not available');
    }
    return this.archiveService.unarchive(projectId, userId);
  }

  /**
   * Find archived projects accessible by a user (delegates to ArchiveService).
   */
  async findArchived(userId: string): Promise<{ projects: EnrichedProject[] }> {
    if (!this.archiveService) {
      return { projects: [] };
    }
    return this.archiveService.findArchived(userId);
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
  async allocateWorkItemIdentifier(
    projectId: string,
  ): Promise<AllocatedIdentifier> {
    return this.projectRepo.allocateWorkItemIdentifier(projectId);
  }

  /**
   * Gets the short prefix code for work items in this project (e.g. 'BIO').
   */
  async getProjectPrefix(projectId: string): Promise<string> {
    const project = await this.assertProjectExists(projectId);
    return deriveProjectPrefix(project.identifier, project.name);
  }

  async duplicateProject(
    projectId: string,
    userId: string,
  ): Promise<{
    project: EnrichedProject;
    yourRole: Role;
    permissions: ProjectPermissions;
  }> {
    const source = await this.projectRepo.findProjectForDuplication(projectId);
    if (!source) throw new NotFoundException(`Project ${projectId} not found`);

    // 1. Generate unique identifier
    const baseIdentifier = deriveProjectPrefix(`${source.name} Copy`);
    let identifier = baseIdentifier;
    let suffix = 1;
    while (await this.projectRepo.findByIdentifier(identifier)) {
      identifier = `${baseIdentifier}${suffix++}`;
    }

    // 2. Clone project atomically in repository
    const newProject = await this.projectRepo.duplicateProject(
      source,
      userId,
      identifier,
    );

    await this.invalidateProjectCache(newProject.id, [userId]);

    // Return enriched project
    const result = await this.findById(newProject.id, userId);
    if (!result?.project)
      throw new NotFoundException('Duplicated project not found');
    return result;
  }

  async permanentDeleteProject(
    projectId: string,
    userId: string,
  ): Promise<{ message: string }> {
    const project = await this.projectRepo.findProjectById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const isOwner =
      project.createdById === userId ||
      project.members?.some(
        (m) => m.userId === userId && m.role === Role.owner,
      );
    if (!isOwner) {
      throw new ForbiddenException('Only project owner can delete project');
    }

    await this.projectRepo.permanentDeleteProject(projectId);
    const memberIds = project.members?.map((m) => m.userId) || [userId];
    await this.invalidateProjectCache(projectId, memberIds);

    this.eventEmitter?.emit(
      'project.deleted',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'deleted',
        actorId: userId,
        projectId,
      }),
    );

    return { message: 'Project permanently deleted' };
  }

  /**
   * Check if a project identifier is available for the user and provide suggestion if taken.
   */
  async checkIdentifierAvailability(
    userId: string,
    identifier?: string,
    name?: string,
  ): Promise<{
    available: boolean;
    identifier: string;
    suggested: string;
  }> {
    const raw =
      identifier?.trim().toUpperCase() ||
      deriveProjectPrefix(null, name) ||
      'PROJ';

    const clean =
      raw
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 10) || 'PROJ';

    const isTaken = await this.projectRepo.isIdentifierTaken(clean, userId);

    return {
      available: !isTaken,
      identifier: clean,
      suggested: clean,
    };
  }
}
