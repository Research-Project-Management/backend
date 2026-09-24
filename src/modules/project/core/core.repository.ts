import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  Prisma,
  Project,
  Role,
  ProjectPriority,
  ProjectState,
} from '@prisma/client';
import {
  ProjectWithMembers,
  ProjectOverview,
  AllocatedIdentifier,
  MinimalUser,
} from './types/project.type';
import { isUuid } from '@/core/utils/uuid.util';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item/work-item.facade';
import { DEFAULT_PROJECT_STATES } from '../state/state.constants';
import { deriveProjectPrefix } from './utils/identifier.util';
import { ProjectQueryDto } from './dto/query.dto';

export const USER_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

export function mapMinimalUser(user: {
  id: string;
  email: string | null;
  profile?: { name: string; avatar: string | null } | null;
}): MinimalUser {
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? 'User',
    avatar: user.profile?.avatar ?? null,
  };
}

export function mapProjectWithMembers<
  T extends {
    createdBy?: {
      id: string;
      email: string | null;
      profile?: { name: string; avatar: string | null } | null;
    } | null;
    members?: Array<{
      user: {
        id: string;
        email: string | null;
        profile?: { name: string; avatar: string | null } | null;
      };
    }>;
  },
>(project: T): any {
  return {
    ...project,
    ...(project.createdBy
      ? { createdBy: mapMinimalUser(project.createdBy) }
      : {}),
    ...(project.members
      ? {
          members: project.members.map((m) => ({
            ...m,
            user: mapMinimalUser(m.user),
          })),
        }
      : {}),
  };
}

export interface CreateProjectInput {
  name: string;
  identifier?: string | null;
  stateId?: string | null;
  priority?: ProjectPriority;
  startDate?: Date | null;
  targetDate?: Date | null;
  labelIds?: string[];
  templateId?: string | null;
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
   * Find projects accessible by a user with rich filtering (state, priority, label, archive).
   */
  async findProjectsByUser(
    userId: string,
    query?: ProjectQueryDto,
  ): Promise<ProjectWithMembers[]> {
    if (!isUuid(userId)) return [];

    const filter = query?.type || 'all';
    const isArchived = query?.isArchived ?? false;

    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      isActive: true,
      isArchived,
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
      ...(query?.stateId ? { stateId: query.stateId } : {}),
      ...(query?.priority ? { priority: query.priority } : {}),
      ...(query?.labelId
        ? { labels: { some: { labelId: query.labelId } } }
        : {}),
    };

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        state: true,
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
      orderBy: { updatedAt: 'desc' },
    });
    return projects.map(mapProjectWithMembers);
  }

  /**
   * Batch-fetch project memberships for a user across multiple project IDs.
   */
  async findMembershipsForUser(
    projectIds: string[],
    userId: string,
  ): Promise<Map<string, Role>> {
    if (!projectIds.length || !isUuid(userId)) return new Map();

    const validProjectIds = projectIds.filter(isUuid);
    if (!validProjectIds.length) return new Map();

    const rows = await this.prisma.projectMember.findMany({
      where: {
        userId,
        projectId: { in: validProjectIds },
      },
      select: { projectId: true, role: true },
    });

    return new Map(rows.map((r) => [r.projectId, r.role]));
  }

  /**
   * Find single project by ID with members, labels, and metadata.
   */
  async findProjectById(projectId: string): Promise<ProjectWithMembers | null> {
    if (!isUuid(projectId)) return null;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      include: {
        createdBy: { select: USER_SELECT },
        members: {
          include: {
            user: { select: USER_SELECT },
          },
          orderBy: { joinedAt: 'asc' },
        },
        labels: {
          include: {
            label: true,
          },
        },
        _count: {
          select: { members: true },
        },
        state: true,
      },
    });
    return project ? mapProjectWithMembers(project) : null;
  }

  /**
   * Find project by unique identifier (e.g. 'DLGA').
   */
  async findProjectByIdentifier(
    identifier: string,
  ): Promise<ProjectWithMembers | null> {
    const project = await this.prisma.project.findFirst({
      where: {
        identifier: { equals: identifier.trim(), mode: 'insensitive' },
        deletedAt: null,
      },
      include: {
        state: true,
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
      },
    });
    return project ? mapProjectWithMembers(project) : null;
  }

  /**
   * Create a new project. The creator is atomically enrolled as project 'owner'.
   */
  async createProject(
    userId: string,
    data: CreateProjectInput,
  ): Promise<ProjectWithMembers> {
    const identifier =
      data.identifier?.trim().toUpperCase() ||
      deriveProjectPrefix(data.identifier, data.name);

    const project = await this.prisma.project.create({
      data: {
        name: data.name.trim(),
        identifier,
        avatar: data.avatar || '',
        coverImage: data.coverImage || '',
        description: data.description || '',
        priority: data.priority || ProjectPriority.none,
        startDate: data.startDate || null,
        targetDate: data.targetDate || null,
        templateId: data.templateId || null,
        modules: data.modules || [
          'work_items',
          'cycles',
          'views',
          'pages',
        ],
        settings: (data.settings || {}) as Prisma.InputJsonValue,
        createdById: userId,
        members: {
          create: {
            userId,
            role: Role.owner,
          },
        },
        ...(data.labelIds && data.labelIds.length > 0
          ? {
              labels: {
                create: data.labelIds.map((labelId) => ({ labelId })),
              },
            }
          : {}),
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
        projectStates: {
          create: DEFAULT_PROJECT_STATES.map((s) => ({
            name: s.name,
            description: s.description,
            color: s.color,
            sequence: s.sequence,
            isDefault: s.isDefault,
          })),
        },
      },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
        projectStates: true,
      },
    });

    // Link initial stateId to the default project state
    const defaultProjectState =
      (data.stateId
        ? project.projectStates?.find((s: ProjectState) => s.id === data.stateId)
        : null) ||
      project.projectStates?.find((s: ProjectState) => s.isDefault) ||
      project.projectStates?.[0];

    if (defaultProjectState) {
      await this.prisma.project.update({
        where: { id: project.id },
        data: {
          stateId: defaultProjectState.id,
        },
      });
      project.stateId = defaultProjectState.id;
      (project as any).state = defaultProjectState;
    }

    return mapProjectWithMembers(project);
  }

  /**
   * Update an existing project's attributes.
   */
  async updateProject(
    projectId: string,
    data: Prisma.ProjectUpdateInput,
  ): Promise<ProjectWithMembers> {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data,
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
      },
    });
    return mapProjectWithMembers(project);
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
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { deletedAt: null, isActive: true },
      include: {
        members: {
          include: {
            user: { select: USER_SELECT },
          },
        },
        labels: {
          include: {
            label: true,
          },
        },
      },
    });
    return mapProjectWithMembers(project);
  }

  /**
   * Archive a project.
   */
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

  /**
   * Restore/unarchive an archived project back to active.
   */
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

  /**
   * List archived projects for a user.
   */
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
      orderBy: { updatedAt: 'desc' },
    });
    return projects.map(mapProjectWithMembers);
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

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        startDate: true,
        targetDate: true,
        state: true,
      },
    });

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
      cyclesCount,
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
      this.prisma.cycle.count({
        where: { projectId },
      }),
    ]);

    const completionPercentage =
      workItemTotal > 0
        ? Math.round((completedWorkItems / workItemTotal) * 100)
        : 0;

    let daysRemaining: number | null = null;
    let isOverdue = false;

    if (project?.targetDate) {
      const now = new Date();
      const target = new Date(project.targetDate);
      const diffMs = target.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      const terminalStates = ['completed', 'cancelled', 'suspended', 'hoàn thành & lưu trữ', 'hủy bỏ', 'tạm dừng'];
      isOverdue =
        daysRemaining < 0 &&
        Boolean(project.state && !terminalStates.includes(project.state.name?.toLowerCase()));
    }

    return {
      totalWorkItems: workItemTotal,
      completedWorkItems,
      inProgressWorkItems,
      backlogWorkItems,
      completionPercentage,
      daysRemaining,
      isOverdue,
      totalMembers: membersCount,
      totalCycles: cyclesCount,
      activeCycle: null,
    };
  }

  // ─── 2. Identifier Sequence Allocation ──────────────────────────────────

  async allocateNextWorkItemSequence(
    projectId: string,
  ): Promise<AllocatedIdentifier> {
    return this.prisma.$transaction(
      async (tx) => {
        const updated = await tx.project.update({
          where: { id: projectId },
          data: {
            workItemSequence: {
              increment: 1,
            },
          },
          select: {
            identifier: true,
            workItemSequence: true,
          },
        });

        return {
          identifier: `${updated.identifier}-${updated.workItemSequence}`,
          sequenceNumber: updated.workItemSequence,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
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
    return this.allocateNextWorkItemSequence(projectId);
  }

  /**
   * Fetch user status and count how many active projects they own.
   */
  async getUserStatusAndOwnedProjectCount(userId: string): Promise<{
    status: string;
    ownedProjectCount: number;
  } | null> {
    if (!isUuid(userId)) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        projectMembers: {
          where: {
            role: Role.owner,
            project: { deletedAt: null },
          },
          select: { projectId: true },
        },
      },
    });

    if (!user) return null;

    return {
      status: user.status,
      ownedProjectCount: user.projectMembers.length,
    };
  }

  async findProjectForDuplication(projectId: string) {
    const [project, manuscriptDocs] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        include: {
          members: { select: { userId: true, role: true } },
          labels: { include: { label: true } },
          projectStates: true,
        },
      }),
      this.prisma.manuscriptDoc.findMany({
        where: { projectId, deleted: false },
        select: {
          id: true,
          path: true,
          lines: true,
          rev: true,
          version: true,
          ranges: true,
          hash: true,
          sizeBytes: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    if (!project) return null;
    return {
      ...project,
      manuscriptDocs,
    };
  }

  async findByIdentifier(identifier: string) {
    return this.prisma.project.findUnique({ where: { identifier } });
  }

  async findTrashedProjectsByUser(userId: string) {
    return this.prisma.project.findMany({
      where: {
        deletedAt: { not: null },
        OR: [
          { createdById: userId },
          { members: { some: { userId } } },
        ],
      },
      include: {
        members: { select: { userId: true, role: true, user: { select: { id: true, email: true, profile: { select: { name: true, avatar: true } } } } } },
        labels: { include: { label: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
  }

  async permanentDeleteProject(projectId: string) {
    return this.prisma.project.delete({ where: { id: projectId } });
  }
}

export { CoreRepository as ProjectRepository };
