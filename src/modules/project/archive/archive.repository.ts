import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, isUuid } from '@/core';
import { USER_SELECT, mapProjectWithMembers } from '../core/core.repository';
import {
  ArchivedPageSummary,
  ArchivedWorkItemSummary,
  ProjectLookupSummary,
  ProjectWithMembers,
} from './types/archive.types';
import {
  extractArchivedPagesFromNodes,
  mapArchivedWorkItemSummary,
} from './domain/archive.domain';

@Injectable()
export class ArchiveRepository {
  constructor(private readonly prisma: PrismaService) {}

  async resolveCanonicalProjectId(
    projectIdOrIdentifier: string,
  ): Promise<string | null> {
    if (!projectIdOrIdentifier) return null;
    if (isUuid(projectIdOrIdentifier)) return projectIdOrIdentifier;

    const proj = await this.prisma.project
      .findFirst({
        where: {
          identifier: { equals: projectIdOrIdentifier, mode: 'insensitive' },
          deletedAt: null,
        },
        select: { id: true },
      })
      .catch(() => null);

    return proj?.id ?? null;
  }

  async findProjectById(
    projectId: string,
  ): Promise<ProjectLookupSummary | null> {
    const canonicalId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalId) return null;

    return this.prisma.project.findFirst({
      where: { id: canonicalId, deletedAt: null },
      select: {
        id: true,
        name: true,
        identifier: true,
        isArchived: true,
        isActive: true,
      },
    });
  }

  async archiveProject(projectId: string): Promise<ProjectWithMembers> {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        isArchived: true,
        archivedAt: new Date(),
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
    return mapProjectWithMembers(project);
  }

  async unarchiveProject(projectId: string): Promise<ProjectWithMembers> {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: {
        isArchived: false,
        archivedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
    return mapProjectWithMembers(project);
  }

  async findArchivedProjectsByUser(
    userId: string,
  ): Promise<ProjectWithMembers[]> {
    if (!isUuid(userId)) return [];

    const projects = await this.prisma.project.findMany({
      where: {
        OR: [{ createdById: userId }, { members: { some: { userId } } }],
        isArchived: true,
        deletedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { archivedAt: 'desc' },
    });

    return projects.map(mapProjectWithMembers);
  }

  /**
   * Finds archived work items scoped strictly to a single project.
   */
  async findProjectArchivedWorkItems(
    projectId: string,
    search?: string,
  ): Promise<ArchivedWorkItemSummary[]> {
    const canonicalId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalId) return [];

    const where: Prisma.WorkItemWhereInput = {
      projectId: canonicalId,
      archivedAt: { not: null },
      deletedAt: null,
    };

    if (search?.trim()) {
      const q = search.trim();
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { identifier: { contains: q, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.workItem.findMany({
      where,
      select: {
        id: true,
        identifier: true,
        title: true,
        priority: true,
        stateId: true,
        completed: true,
        archivedAt: true,
        updatedAt: true,
        projectId: true,
        state: {
          select: { group: true },
        },
        assignee: {
          select: USER_SELECT,
        },
      },
      orderBy: { archivedAt: 'desc' },
      take: 200,
    });

    return rows.map(mapArchivedWorkItemSummary);
  }

  /**
   * Finds archived manuscript pages scoped strictly to a single project.
   */
  async findProjectArchivedPages(
    projectId: string,
    search?: string,
  ): Promise<ArchivedPageSummary[]> {
    const canonicalId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalId) return [];

    // Resolve spaceId (which can equal canonicalId or space.id for projectId)
    const space = await this.prisma.space
      ?.findFirst?.({
        where: { OR: [{ id: canonicalId }, { projectId: canonicalId }] },
        select: { id: true },
      })
      .catch(() => null);

    const spaceIds = Array.from(
      new Set([canonicalId, ...(space?.id ? [space.id] : [])]),
    );

    const rootNodes = await this.prisma.pageNode
      .findMany({
        where: {
          spaceId: { in: spaceIds },
          isRootDoc: true,
          OR: [{ docId: null }, { doc: { deletedAt: null } }],
        },
        include: {
          doc: {
            select: {
              id: true,
              path: true,
              ranges: true,
              version: true,
              rev: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      })
      .catch(() => []);

    return extractArchivedPagesFromNodes(canonicalId, rootNodes, search);
  }

  /**
   * Restores one or more archived work items belonging to a project.
   */
  async restoreProjectWorkItems(
    projectId: string,
    workItemIds: string[],
  ): Promise<number> {
    const canonicalId = await this.resolveCanonicalProjectId(projectId);
    const validIds = workItemIds.filter(isUuid);
    if (!canonicalId || validIds.length === 0) return 0;

    const result = await this.prisma.workItem.updateMany({
      where: {
        id: { in: validIds },
        projectId: canonicalId,
        deletedAt: null,
      },
      data: {
        archivedAt: null,
      },
    });

    return result.count;
  }

  /**
   * Restores an archived page document to active ('published') status within a project.
   */
  async restoreProjectPage(
    projectId: string,
    pageId: string,
  ): Promise<boolean> {
    const canonicalId = await this.resolveCanonicalProjectId(projectId);
    if (!canonicalId || !isUuid(pageId)) return false;

    const doc = await this.prisma.pageDoc
      .findFirst({
        where: { id: pageId, deletedAt: null },
        select: { id: true, ranges: true },
      })
      .catch(() => null);

    if (!doc) return false;

    const existingRanges =
      doc.ranges && typeof doc.ranges === 'object'
        ? (doc.ranges as Record<string, unknown>)
        : {};

    await this.prisma.pageDoc.update({
      where: { id: doc.id },
      data: {
        ranges: {
          ...existingRanges,
          status: 'published',
        },
      },
    });

    return true;
  }
}
