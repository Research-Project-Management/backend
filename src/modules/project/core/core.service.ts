import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CoreRepository } from './core.repository';
import { Role, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis.service';
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
import { FavoriteRepository } from '../favorite/favorite.repository';
import { LabelRepository } from '../label/label.repository';
import { deriveProjectPrefix } from './utils/identifier.util';
import { PrismaService } from '@/core/database/prisma.service';

export const ALLOWED_PROJECT_MODULES = new Set([
  'overview',
  'work_items',
  'work-items',
  'cycles',
  'views',
  'pages',
]);

export function sanitizeModules(modules?: string[]): string[] {
  if (!modules || !Array.isArray(modules) || modules.length === 0) {
    return ['overview', 'work_items', 'cycles', 'views', 'pages'];
  }
  const filtered = modules
    .map((m) => String(m).trim().toLowerCase())
    .filter((m) => ALLOWED_PROJECT_MODULES.has(m));
  return filtered.length > 0
    ? filtered
    : ['overview', 'work_items', 'cycles', 'views', 'pages'];
}

@Injectable()
export class CoreService {
  constructor(
    private readonly projectRepo: CoreRepository,
    private readonly favoriteRepo: FavoriteRepository,
    private readonly labelRepo: LabelRepository,
    private readonly prisma: PrismaService,
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
    const favoriteSet = await this.favoriteRepo.batchCheckFavorites(
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

    const isFavorite = await this.favoriteRepo.isFavorite(projectId, userId);
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
        await this.projectRepo.findProjectByIdentifier(identifier);
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
      await this.labelRepo.replaceProjectLabels(projectId, dto.labelIds);
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
        settings: dto.settings as any,
      }),
    });

    if (dto.isFavorite !== undefined && actorId) {
      if (dto.isFavorite) {
        await this.favoriteRepo.addFavorite(projectId, actorId);
      } else {
        await this.favoriteRepo.removeFavorite(projectId, actorId);
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
    if (existing.isArchived) {
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
    if (!existing.isArchived) {
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
  async findArchived(userId: string): Promise<{ projects: EnrichedProject[] }> {
    const projects = await this.projectRepo.findArchivedProjectsByUser(userId);
    const sharedProjectIds = projects
      .filter((p) => p.createdById !== userId)
      .map((p) => p.id);

    const membershipMap = await this.projectRepo.findMembershipsForUser(
      sharedProjectIds,
      userId,
    );

    const enriched: EnrichedProject[] = projects.map((p) => {
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
        projectLabelsList: p.labels?.map((l) => l.label) || [],
      };
    });

    return { projects: enriched };
  }

  async allocateNextWorkItemSequence(
    projectId: string,
  ): Promise<AllocatedIdentifier> {
    return this.projectRepo.allocateNextWorkItemSequence(projectId);
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

  async duplicateProject(projectId: string, userId: string): Promise<{ project: EnrichedProject; yourRole: Role; permissions: ProjectPermissions }> {
    const source = await this.projectRepo.findProjectForDuplication(projectId);
    if (!source) throw new NotFoundException(`Project ${projectId} not found`);

    // 1. Generate unique identifier
    const baseIdentifier = deriveProjectPrefix(`${source.name} Copy`);
    let identifier = baseIdentifier;
    let suffix = 1;
    while (await this.projectRepo.findByIdentifier(identifier)) {
      identifier = `${baseIdentifier}${suffix++}`;
    }

    // 2. Create new project
    const newProject = await this.prisma.project.create({
      data: {
        name: `${source.name} (Copy)`,
        identifier,
        description: source.description ?? '',
        avatar: source.avatar ?? undefined,
        coverImage: source.coverImage ?? undefined,
        modules: source.modules ? (source.modules as any) : undefined,
        createdById: userId,
      }
    });

    // 3. Add creator as owner member
    await this.prisma.projectMember.create({
      data: { projectId: newProject.id, userId, role: 'owner' },
    });

    // 4. Clone ProjectStates
    const stateIdMap = new Map<string, string>();
    for (const state of source.projectStates) {
      const newState = await this.prisma.projectState.create({
        data: {
          projectId: newProject.id,
          name: state.name,
          color: state.color,
          description: state.description ?? '',
          sequence: state.sequence,
          isDefault: state.isDefault,
        },
      });
      stateIdMap.set(state.id, newState.id);
    }

    // 5. Clone Pages — two passes for parent/mainFile hierarchy
    const pageIdMap = new Map<string, string>();
    // First pass: create all pages without parent/mainFile links
    for (const page of source.pages) {
      const newPage = await this.prisma.page.create({
        data: {
          title: page.title,
          slug: page.slug ?? undefined,
          icon: page.icon ?? undefined,
          coverImage: page.coverImage ?? undefined,
          content: (page.content ?? {}) as any,
          status: page.status,
          rank: page.rank,
          isLocked: false,
          isPublished: false,
          projectId: newProject.id,
          authorId: userId,
        },
      });
      pageIdMap.set(page.id, newPage.id);
    }
    // Second pass: wire parentPageId and mainFileId using the map
    for (const page of source.pages) {
      const newPageId = pageIdMap.get(page.id);
      if (!newPageId) continue;
      const newParentId = page.parentPageId ? pageIdMap.get(page.parentPageId) : null;
      const newMainFileId = page.mainFileId ? pageIdMap.get(page.mainFileId) : null;
      if (newParentId !== undefined || newMainFileId !== undefined) {
        await this.prisma.page.update({
          where: { id: newPageId },
          data: {
            ...(newParentId ? { parentPageId: newParentId } : {}),
            ...(newMainFileId ? { mainFileId: newMainFileId } : {}),
          },
        });
      }
    }

    await this.invalidateProjectCache(newProject.id, [userId]);

    // Return enriched project
    const result = await this.findById(newProject.id, userId);
    if (!result?.project) throw new NotFoundException('Duplicated project not found');
    return result;
  }

  async getTrashedProjects(userId: string): Promise<{ projects: EnrichedProject[] }> {
    const projects = await this.projectRepo.findTrashedProjectsByUser(userId);
    const enriched: EnrichedProject[] = projects.map((p: any) => ({
      ...p,
      yourRole: p.createdById === userId ? Role.owner
        : p.members?.find((m: any) => m.userId === userId)?.role ?? Role.reviewer,
      permissions: calculateProjectPermissions(
        p.createdById === userId ? Role.owner
          : p.members?.find((m: any) => m.userId === userId)?.role ?? Role.reviewer,
        p.isActive,
      ),
      projectLabelsList: p.labels?.map((l: any) => l.label) || [],
    }));
    return { projects: enriched };
  }

  async permanentDeleteProject(projectId: string, userId: string): Promise<{ message: string }> {
    const project = await this.projectRepo.findProjectById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    if (project.createdById !== userId) throw new ForbiddenException('Only project owner can permanently delete');
    if (!project.deletedAt) throw new BadRequestException('Project must be soft-deleted before permanent deletion');
    await this.projectRepo.permanentDeleteProject(projectId);
    await this.invalidateProjectCache(projectId, [userId]);
    return { message: 'Project permanently deleted' };
  }
}

export { CoreService as ProjectService };
