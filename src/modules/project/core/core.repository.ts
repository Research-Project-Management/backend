import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, Project, ProjectMemberRole } from '@prisma/client';
import {
  ProjectWithMembers,
  ProjectOverview,
  AllocatedIdentifier,
} from './types/project.type';
import { isUuid } from '@/core/utils/uuid.util';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item/state/types/state.types';
import { deriveProjectPrefix } from './utils/identifier.util';
import { parseWorkItemStates } from '@/modules/work-item/state/utils/state.util';

export const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export interface CreateProjectInput {
  name: string;
  identifier?: string | null;
  avatar?: string;
  coverImage?: string;
  description?: string;
  modules?: string[];
  settings?: Record<string, unknown>;
}

@Injectable()
export class CoreRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── 1. Core Project Lifecycle & Retrieval ─────────────────────────────────

  /**
   * Find active projects accessible by a user (created by them or where they are a member).
   */
  async findProjectsByUser(
    userId: string,
    filter: 'created' | 'shared' | 'all' = 'all',
  ): Promise<ProjectWithMembers[]> {
    if (!isUuid(userId)) return [];

    const where: Prisma.ProjectWhereInput = {
      isActive: true,
      deletedAt: null,
      ...(filter === 'created'
        ? { createdById: userId }
        : filter === 'shared'
          ? {
              createdById: { not: userId },
              members: { some: { userId } },
            }
          : {
              OR: [{ createdById: userId }, { members: { some: { userId } } }],
            }),
    };

    return this.prisma.project.findMany({
      where,
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Find a project by its unique UUID or uppercase identifier code.
   */
  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
    if (!projectId) return null;

    const where: Prisma.ProjectWhereInput = isUuid(projectId)
      ? { id: projectId, deletedAt: null }
      : {
          identifier: { equals: projectId, mode: 'insensitive' },
          deletedAt: null,
        };

    return this.prisma.project.findFirst({
      where,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  /**
   * Find a project by its unique WorkItem identifier key (e.g. "FLUX", "BIO").
   */
  async findProjectByIdentifier(
    identifier: string,
  ): Promise<ProjectWithMembers | null> {
    if (!identifier) return null;

    return this.prisma.project.findFirst({
      where: {
        identifier: { equals: identifier.trim(), mode: 'insensitive' },
        deletedAt: null,
      },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  /**
   * Create a new project. The creator is atomically enrolled as the project 'owner'.
   */
  async createProject(
    userId: string,
    data: CreateProjectInput,
  ): Promise<ProjectWithMembers> {
    const identifier =
      data.identifier?.trim().toUpperCase() || deriveProjectPrefix(data.name);

    return this.prisma.project.create({
      data: {
        name: data.name.trim(),
        identifier,
        avatar: data.avatar || '',
        coverImage: data.coverImage || '',
        description: data.description || '',
        modules: data.modules || [
          'work_items',
          'cycles',
          'views',
          'pages',
          'stickies',
          'storage',
        ],
        settings: (data.settings || {}) as Prisma.InputJsonValue,
        createdBy: { connect: { id: userId } },
        members: {
          create: {
            userId,
            role: ProjectMemberRole.owner,
          },
        },
        states: {
          create: DEFAULT_WORK_ITEM_STATES.map((s) => ({
            name: s.name,
            color: s.color,
            group: s.group,
            sequence: s.sequence,
            isDefault: s.isDefault ?? false,
            description: s.description || '',
          })),
        },
      },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  /**
   * Update an existing project's attributes.
   */
  async updateProject(
    projectId: string,
    data: Prisma.ProjectUpdateInput,
  ): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  /**
   * Soft-delete a project.
   */
  async softDeleteProject(projectId: string): Promise<Project> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /**
   * Restore a soft-deleted project.
   */
  async restoreProject(projectId: string): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: null, isActive: true },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
      },
    });
  }

  /**
   * Archive a project (make inactive).
   */
  async archiveProject(projectId: string): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { isActive: false },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
  }

  /**
   * Restore/unarchive an archived project back to active.
   */
  async unarchiveProject(projectId: string): Promise<ProjectWithMembers> {
    return this.prisma.project.update({
      where: { id: projectId },
      data: { isActive: true },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        _count: {
          select: { members: true },
        },
      },
    });
  }

  /**
   * List archived projects for a user.
   */
  async findArchivedProjectsByUser(
    userId: string,
  ): Promise<ProjectWithMembers[]> {
    if (!isUuid(userId)) return [];

    return this.prisma.project.findMany({
      where: {
        OR: [{ createdById: userId }, { members: { some: { userId } } }],
        isActive: false,
        deletedAt: null,
      },
      include: {
        members: {
          take: 20,
          include: {
            user: { select: USER_SELECT },
          },
        },
        _count: {
          select: { members: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Retrieve aggregated project dashboard overview statistics.
   */
  async findProjectOverview(
    projectId: string,
  ): Promise<ProjectOverview | null> {
    if (!isUuid(projectId)) {
      const proj = await this.findProjectById(projectId);
      if (!proj) return null;
      projectId = proj.id;
    }

    const states = await this.prisma.workItemState.findMany({
      where: { projectId },
      select: { id: true, group: true },
    });

    const stateList: { id: string; group: string }[] = states;

    const completedStateIds = stateList
      .filter((s) => s.group === 'completed')
      .map((s) => s.id);
    const startedStateIds = stateList
      .filter((s) => s.group === 'started')
      .map((s) => s.id);
    const backlogStateIds = stateList
      .filter((s) => ['backlog', 'unstarted'].includes(s.group))
      .map((s) => s.id);

    const [
      workItemTotal,
      completedWorkItems,
      inProgressWorkItems,
      backlogWorkItems,
      membersCount,
    ] = await Promise.all([
      this.prisma.workItem.count({
        where: { projectId, deletedAt: null },
      }),
      this.prisma.workItem.count({
        where: {
          projectId,
          deletedAt: null,
          ...(completedStateIds.length > 0
            ? { columnId: { in: completedStateIds } }
            : { completed: true }),
        },
      }),
      this.prisma.workItem.count({
        where: {
          projectId,
          deletedAt: null,
          ...(startedStateIds.length > 0
            ? { columnId: { in: startedStateIds } }
            : backlogStateIds.length > 0
              ? {
                  columnId: {
                    notIn: [...backlogStateIds, ...completedStateIds],
                  },
                  completed: false,
                }
              : { completed: false }),
        },
      }),
      this.prisma.workItem.count({
        where: {
          projectId,
          deletedAt: null,
          ...(backlogStateIds.length > 0
            ? { columnId: { in: backlogStateIds } }
            : startedStateIds.length > 0 || completedStateIds.length > 0
              ? {
                  columnId: {
                    notIn: [...startedStateIds, ...completedStateIds],
                  },
                  completed: false,
                }
              : { completed: false, columnId: 'backlog' }),
        },
      }),
      this.prisma.projectMember.count({
        where: { projectId },
      }),
    ]);

    return {
      totalWorkItems: workItemTotal,
      completedWorkItems,
      inProgressWorkItems,
      backlogWorkItems,
      totalMembers: membersCount,
      totalCycles: 0,
      activeCycle: null,
    };
  }

  /**
   * Atomic WorkItem state deletion with reassignment of active work items to a fallback state.
   */
  async deleteColumnWithWorkItemMigration(
    projectId: string,
    stateId: string,
    fallbackStateId: string,
  ): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      await tx.workItem.updateMany({
        where: {
          projectId,
          columnId: stateId,
          deletedAt: null,
        },
        data: {
          columnId: fallbackStateId,
        },
      });

      return tx.project.findUniqueOrThrow({
        where: { id: projectId },
      });
    });
  }

  /**
   * Check if a user is an enrolled member of a project.
   */
  async isProjectMember(projectId: string, userId: string): Promise<boolean> {
    if (!isUuid(projectId) || !isUuid(userId)) return false;
    const count = await this.prisma.projectMember.count({
      where: { projectId, userId },
    });
    return count > 0;
  }

  /**
   * Retrieve project settings JSON object.
   */
  async getProjectSettings(
    projectId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!isUuid(projectId)) return null;
    const proj = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { settings: true },
    });
    return (proj?.settings as Record<string, unknown>) || null;
  }

  /**
   * Allocate the next sequential WorkItem identifier (e.g. 'BIO-1', 'BIO-2').
   */
  async allocateWorkItemIdentifier(
    projectId: string,
  ): Promise<AllocatedIdentifier> {
    const project = await this.prisma.project.findFirst({
      where: isUuid(projectId)
        ? { id: projectId, deletedAt: null }
        : {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
      select: { id: true, identifier: true, name: true },
    });

    const prefix = deriveProjectPrefix(project?.identifier, project?.name);
    const resolvedProjectId = project?.id || projectId;

    // Count existing work items in this project to derive next sequence
    const currentCount = await this.prisma.workItem.count({
      where: { projectId: resolvedProjectId },
    });
    const sequenceNumber = currentCount + 1;

    return {
      identifier: `${prefix}-${sequenceNumber}`,
      sequenceNumber,
    };
  }
}

export { CoreRepository as ProjectRepository };
