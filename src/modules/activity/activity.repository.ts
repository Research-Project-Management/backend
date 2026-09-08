import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import { DomainActivityEvent } from './events/activity.events';
import { EntityType, ActivityEvent } from '@prisma/client';
import {
  IActivityRepository,
  ActivityEventWithActor,
  ACTOR_MINIMAL_SELECT,
} from './types/activity-repository.interface';

@Injectable()
export class ActivityRepository implements IActivityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(event: DomainActivityEvent): Promise<ActivityEvent> {
    return this.prisma.activityEvent.create({
      data: {
        entityType: event.entityType,
        entityId: event.entityId,
        verb: event.verb,
        field: event.field,
        oldValue: event.oldValue,
        newValue: event.newValue,
        oldIdentifier: event.oldIdentifier,
        newIdentifier: event.newIdentifier,
        actorId: event.actorId,
        workspaceId: event.workspaceId,
        projectId: event.projectId,
      },
    });
  }

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findWorkspaceFeed(
    workspaceId: string,
    options?: {
      projectId?: string;
      entityType?: EntityType;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: ActivityEventWithActor[]; total: number }> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return { items: [], total: 0 };

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const where: any = { workspaceId: canonicalWorkspaceId };
    if (options?.projectId && isUuid(options.projectId)) {
      where.projectId = options.projectId;
    }
    if (options?.entityType) {
      where.entityType = options.entityType;
    }

    const [items, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          actor: { select: ACTOR_MINIMAL_SELECT },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.activityEvent.count({ where }),
    ]);

    return { items, total };
  }

  async findEntityFeed(
    entityType: EntityType,
    entityId: string,
    limit = 50,
  ): Promise<ActivityEventWithActor[]> {
    if (!isUuid(entityId)) return [];
    return this.prisma.activityEvent.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: ACTOR_MINIMAL_SELECT },
        project: { select: { id: true, name: true } },
      },
    });
  }

  async findRecentByActor(
    workspaceId: string,
    actorId: string,
    limit = 50,
  ): Promise<ActivityEvent[]> {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId || !isUuid(actorId)) return [];

    return this.prisma.activityEvent.findMany({
      where: {
        workspaceId: canonicalWorkspaceId,
        actorId,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Batch-resolve titles for recent entities (task / paper / page).
   * Returns a Map<"type:id", title>.
   */
  async findEntitiesTitleMap(
    taskIds: string[],
    paperIds: string[],
    pageIds: string[],
  ): Promise<Map<string, string>> {
    const validTaskIds = taskIds.filter(isUuid);
    const validPaperIds = paperIds.filter(isUuid);
    const validPageIds = pageIds.filter(isUuid);

    const [tasks, papers, pages] = await Promise.all([
      validTaskIds.length
        ? this.prisma.task.findMany({
            where: { id: { in: validTaskIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      validPaperIds.length
        ? this.prisma.catalogItem.findMany({
            where: { id: { in: validPaperIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
      validPageIds.length
        ? this.prisma.page.findMany({
            where: { id: { in: validPageIds }, deletedAt: null },
            select: { id: true, title: true },
          })
        : [],
    ]);

    const map = new Map<string, string>();
    tasks.forEach((t) => map.set(`task:${t.id}`, t.title));
    papers.forEach((p) => map.set(`paper:${p.id}`, p.title));
    pages.forEach((pg) => map.set(`page:${pg.id}`, pg.title));
    return map;
  }

  /**
   * Fallback: get recently updated items owned by user across all entity types.
   */
  async findFallbackRecentItems(
    workspaceId: string,
    userId: string,
    limit: number,
  ) {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId || !isUuid(userId)) {
      return { tasks: [], papers: [], pages: [] };
    }

    const [tasks, papers, pages] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          project: { workspaceId: canonicalWorkspaceId },
          deletedAt: null,
          OR: [{ authorId: userId }, { assigneeId: userId }],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
      this.prisma.catalogItem.findMany({
        where: {
          workspaceId: canonicalWorkspaceId,
          uploadedById: userId,
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, updatedAt: true },
      }),
      this.prisma.page.findMany({
        where: {
          deletedAt: null,
          OR: [
            { workspaceId: canonicalWorkspaceId, authorId: userId },
            {
              project: { workspaceId: canonicalWorkspaceId },
              authorId: userId,
            },
          ],
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, projectId: true, updatedAt: true },
      }),
    ]);
    return { tasks, papers, pages };
  }
}
