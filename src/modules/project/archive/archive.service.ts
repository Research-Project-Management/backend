import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { RedisCacheService } from '@/core';
import { CACHE_KEYS } from '../core/constants/cache.constant';
import { CoreRepository } from '../core/core.repository';
import { ArchiveRepository } from './archive.repository';
import {
  BulkRestoreProjectArchivesDto,
  QueryProjectArchivesDto,
} from './dto/archive.dto';
import {
  EnrichedProject,
  ProjectScopedArchivesResult,
  ProjectWithMembers,
} from './types/archive.types';
import {
  assertProjectArchiveTransition,
  enrichArchivedProjectsForUser,
} from './domain/archive.domain';

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

    const enriched = enrichArchivedProjectsForUser(
      projects,
      userId,
      membershipMap,
    );

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
    assertProjectArchiveTransition(existing, projectId, true);

    const archived = await this.archiveRepo.archiveProject(existing.id);
    const memberIds = archived.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(existing.id, memberIds);

    this.eventEmitter?.emit(
      'project.archived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: existing.id,
        verb: 'archived',
        actorId: userId || '',
        projectId: existing.id,
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
    assertProjectArchiveTransition(existing, projectId, false);

    const restored = await this.archiveRepo.unarchiveProject(existing.id);
    const memberIds = restored.members?.map((m) => m.userId) || [];
    await this.invalidateProjectCache(existing.id, memberIds);

    this.eventEmitter?.emit(
      'project.unarchived',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: existing.id,
        verb: 'restored',
        actorId: userId || '',
        projectId: existing.id,
      }),
    );

    return {
      message: 'Project restored from archive successfully',
      project: restored,
    };
  }

  /**
   * Get project-scoped archived items (work items + pages) strictly for a single project.
   */
  async getProjectArchives(
    projectId: string,
    query: QueryProjectArchivesDto = {},
  ): Promise<ProjectScopedArchivesResult> {
    const includeWorkItems =
      !query.type || query.type === 'all' || query.type === 'work-items';
    const includePages =
      !query.type || query.type === 'all' || query.type === 'pages';

    const [workItems, pages] = await Promise.all([
      includeWorkItems
        ? this.archiveRepo.findProjectArchivedWorkItems(projectId, query.search)
        : Promise.resolve([]),
      includePages
        ? this.archiveRepo.findProjectArchivedPages(projectId, query.search)
        : Promise.resolve([]),
    ]);

    return {
      projectId,
      workItems,
      pages,
      counts: {
        workItems: workItems.length,
        pages: pages.length,
        total: workItems.length + pages.length,
      },
    };
  }

  /**
   * Restore archived work items and/or pages within a single project.
   */
  async restoreProjectItems(
    projectId: string,
    dto: BulkRestoreProjectArchivesDto,
    userId?: string,
  ): Promise<{
    success: boolean;
    restoredWorkItems: number;
    restoredPages: number;
    message: string;
  }> {
    const workItemIds = dto.workItemIds || dto.ids || [];
    const pageIds = dto.pageIds || [];

    if (workItemIds.length === 0 && pageIds.length === 0) {
      throw new BadRequestException(
        'No archived item IDs provided to restore',
      );
    }

    const [restoredWorkItems, pageResults] = await Promise.all([
      workItemIds.length > 0
        ? this.archiveRepo.restoreProjectWorkItems(projectId, workItemIds)
        : Promise.resolve(0),
      pageIds.length > 0
        ? Promise.all(
            pageIds.map((pid) =>
              this.archiveRepo.restoreProjectPage(projectId, pid),
            ),
          )
        : Promise.resolve([]),
    ]);

    const restoredPages = pageResults.filter(Boolean).length;
    await this.invalidateProjectCache(projectId, userId ? [userId] : []);

    return {
      success: true,
      restoredWorkItems,
      restoredPages,
      message: `Successfully restored ${restoredWorkItems + restoredPages} item(s)`,
    };
  }
}
