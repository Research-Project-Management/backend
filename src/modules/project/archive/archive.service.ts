import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ArchiveRepository } from './archive.repository';
import { ProjectMemberRole, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core/cache/redis.service';
import { CACHE_KEYS } from '../core/constants/cache.constant';
import { EnrichedProject, ProjectWithMembers } from '../core/types/project.type';
import { calculateProjectPermissions } from '../core/utils/permission.util';
import { CoreRepository } from '../core/core.repository';

@Injectable()
export class ArchiveService {
  constructor(
    private readonly archiveRepo: ArchiveRepository,
    private readonly coreRepo: CoreRepository,
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

  /**
   * Find archived projects accessible by a user.
   */
  async findArchived(userId: string): Promise<{ projects: EnrichedProject[] }> {
    const projects = await this.archiveRepo.findArchivedProjectsByUser(userId);
    const sharedProjectIds = projects
      .filter((p) => p.createdById !== userId)
      .map((p) => p.id);

    const membershipMap = await this.coreRepo.findMembershipsForUser(
      sharedProjectIds,
      userId,
    );

    const enriched: EnrichedProject[] = projects.map((p) => {
      const yourRole =
        p.createdById === userId
          ? ProjectMemberRole.owner
          : membershipMap.get(p.id) ||
            p.members?.find((m) => m.userId === userId)?.role ||
            ProjectMemberRole.viewer;
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
    const existing = await this.archiveRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }
    if (existing.isArchived) {
      throw new BadRequestException('Project is already archived');
    }

    const archived = await this.archiveRepo.archiveProject(projectId);
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
    const existing = await this.archiveRepo.findProjectById(projectId);
    if (!existing) {
      throw new NotFoundException(`Project with ID "${projectId}" not found`);
    }
    if (!existing.isArchived) {
      throw new BadRequestException('Project is not archived');
    }

    const restored = await this.archiveRepo.unarchiveProject(projectId);
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
}
