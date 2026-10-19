import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@/core';
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
  ProjectMemberWithUser,
} from './types/project.type';
import { isUuid } from '@/core';
import { DEFAULT_WORK_ITEM_STATES } from '@/modules/work-item';
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
>(project: T): ProjectWithMembers {
  return {
    ...(project as unknown as Project),
    ...(project.createdBy
      ? { createdBy: mapMinimalUser(project.createdBy) }
      : {}),
    ...(project.members
      ? {
          members: project.members.map((m) => ({
            ...m,
            user: mapMinimalUser(m.user),
          })) as ProjectMemberWithUser[],
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
    const trimmed = (projectId || '').trim();
    if (!trimmed) return null;

    const where: Prisma.ProjectWhereInput = isUuid(trimmed)
      ? { id: trimmed, deletedAt: null }
      : {
          deletedAt: null,
          OR: [
            { identifier: { equals: trimmed, mode: 'insensitive' } },
            { name: { equals: trimmed, mode: 'insensitive' } },
          ],
        };

    const project = await this.prisma.project.findFirst({
      where,
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
   * Find project by identifier within a user's scope (or globally if userId omitted).
   */
  async findProjectByIdentifier(
    identifier: string,
    userId?: string,
  ): Promise<ProjectWithMembers | null> {
    const whereClause: Prisma.ProjectWhereInput = {
      identifier: { equals: identifier.trim(), mode: 'insensitive' },
      deletedAt: null,
    };
    if (userId) {
      whereClause.createdById = userId;
    }

    const project = await this.prisma.project.findFirst({
      where: whereClause,
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
   * Check whether a project identifier is already used by the specified user (or globally if userId omitted).
   */
  async isIdentifierTaken(
    identifier: string,
    userId?: string,
  ): Promise<boolean> {
    if (!identifier) return false;
    const whereClause: Prisma.ProjectWhereInput = {
      identifier: { equals: identifier.trim(), mode: 'insensitive' },
      deletedAt: null,
    };
    if (userId) {
      whereClause.createdById = userId;
    }
    const count = await this.prisma.project.count({ where: whereClause });
    return count > 0;
  }

  /**
   * Find an available unique project identifier for the user starting from a desired prefix.
   * e.g. "FLUX" -> if user already has "FLUX", returns "FLUX2", "FLUX3", etc.
   * Different users NEVER conflict!
   */
  async findAvailableIdentifier(
    desiredPrefix: string,
    userId?: string,
  ): Promise<string> {
    const clean =
      desiredPrefix
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '') || 'PROJ';

    const baseCandidate = clean.slice(0, 10);
    const taken = await this.isIdentifierTaken(baseCandidate, userId);
    if (!taken) {
      return baseCandidate;
    }

    let suffix = 2;
    while (true) {
      const suffixStr = String(suffix);
      const baseLen = Math.min(clean.length, 10 - suffixStr.length);
      const candidate = `${clean.slice(0, baseLen)}${suffixStr}`;
      const isTaken = await this.isIdentifierTaken(candidate, userId);
      if (!isTaken) {
        return candidate;
      }
      suffix++;
    }
  }

  /**
   * Create a new project. The creator is atomically enrolled as project 'owner'.
   */
  async createProject(
    userId: string,
    data: CreateProjectInput,
  ): Promise<ProjectWithMembers> {
    const rawIdentifier =
      data.identifier?.trim().toUpperCase() ||
      deriveProjectPrefix(data.identifier, data.name);

    const identifier =
      rawIdentifier
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 10) || 'PROJ';

    const isTaken = await this.isIdentifierTaken(identifier, userId);
    if (isTaken) {
      throw new BadRequestException(
        `A project with identifier "${identifier}" already exists in your workspace.`,
      );
    }

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
        modules: data.modules || ['overview', 'work-items', 'pages'],
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
        ? project.projectStates?.find(
            (s: ProjectState) => s.id === data.stateId,
          )
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
    }

    return mapProjectWithMembers({
      ...project,
      state: defaultProjectState ?? null,
    });
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
      Promise.resolve(0),
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
      const terminalStates = [
        'completed',
        'completed & archived',
        'cancelled',
        'suspended',
      ];
      isOverdue =
        daysRemaining < 0 &&
        Boolean(
          project.state &&
          !terminalStates.includes(project.state.name?.toLowerCase()),
        );
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

  /**
   * Allocate the next sequential WorkItem identifier (e.g. 'BIO-1', 'BIO-2').
   */
  async allocateWorkItemIdentifier(
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
    const [project, manuscriptDocs, manuscriptFiles, manuscriptNodes] =
      await Promise.all([
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
        this.prisma.manuscriptFile.findMany({
          where: { projectId, deleted: false },
          select: {
            id: true,
            name: true,
            mimeType: true,
            sizeBytes: true,
            hash: true,
            storageKey: true,
            bucketName: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
        this.prisma.manuscriptNode.findMany({
          where: { projectId },
          orderBy: { depth: 'asc' },
        }),
      ]);
    if (!project) return null;
    return {
      ...project,
      manuscriptDocs,
      manuscriptFiles,
      manuscriptNodes,
    };
  }

  async findByIdentifier(identifier: string, userId?: string) {
    return this.prisma.project.findFirst({
      where: {
        identifier: { equals: identifier.trim(), mode: 'insensitive' },
        ...(userId ? { createdById: userId } : {}),
        deletedAt: null,
      },
    });
  }

  async duplicateProject(
    source: NonNullable<
      Awaited<ReturnType<CoreRepository['findProjectForDuplication']>>
    >,
    userId: string,
    identifier: string,
  ): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Create new project
      const newProject = await tx.project.create({
        data: {
          name: `${source.name} (Copy)`,
          identifier,
          description: source.description ?? '',
          avatar: source.avatar ?? undefined,
          coverImage: source.coverImage ?? undefined,
          modules: source.modules ?? undefined,
          createdById: userId,
        },
      });

      // 2. Add creator as owner member
      await tx.projectMember.create({
        data: { projectId: newProject.id, userId, role: 'owner' },
      });

      // 3. Clone ProjectStates
      const stateIdMap = new Map<string, string>();
      for (const state of source.projectStates) {
        const newState = await tx.projectState.create({
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

      // 4. Clone Manuscript Documents (map oldDocId -> newDocId)
      const docIdMap = new Map<string, string>();
      if (source.manuscriptDocs && source.manuscriptDocs.length > 0) {
        for (const doc of source.manuscriptDocs) {
          const newDoc = await tx.manuscriptDoc.create({
            data: {
              projectId: newProject.id,
              path: doc.path,
              lines: doc.lines ?? [],
              rev: 0,
              version: 1,
              ranges: doc.ranges ?? {},
              hash: doc.hash,
              sizeBytes: doc.sizeBytes,
            },
          });
          docIdMap.set(doc.id, newDoc.id);
        }
      }

      // 5. Clone Manuscript Files (map oldFileId -> newFileId, reusing CAS blob storageKey)
      const fileIdMap = new Map<string, string>();
      const manuscriptFiles = source.manuscriptFiles || [];
      for (const file of manuscriptFiles) {
        const newFile = await tx.manuscriptFile.create({
          data: {
            projectId: newProject.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
            hash: file.hash,
            storageKey: file.storageKey,
            bucketName: file.bucketName,
            rev: 0,
          },
        });
        fileIdMap.set(file.id, newFile.id);
      }

      // 6. Clone Manuscript Nodes (file tree hierarchy)
      const nodeIdMap = new Map<string, string>();
      const manuscriptNodes = source.manuscriptNodes || [];
      for (const node of manuscriptNodes) {
        const newParentId = node.parentId
          ? nodeIdMap.get(node.parentId) || null
          : null;
        const newDocId = node.docId ? docIdMap.get(node.docId) || null : null;
        const newFileId = node.fileId
          ? fileIdMap.get(node.fileId) || null
          : null;

        const newNode = await tx.manuscriptNode.create({
          data: {
            projectId: newProject.id,
            parentId: newParentId,
            type: node.type,
            name: node.name,
            path: node.path,
            depth: node.depth,
            docId: newDocId,
            fileId: newFileId,
            isRootDoc: node.isRootDoc,
            sizeBytes: node.sizeBytes,
            hash: node.hash,
            sortOrder: node.sortOrder,
          },
        });
        nodeIdMap.set(node.id, newNode.id);
      }

      return newProject;
    });
  }

  async findTrashedProjectsByUser(
    userId: string,
  ): Promise<ProjectWithMembers[]> {
    const raw = await this.prisma.project.findMany({
      where: {
        deletedAt: { not: null },
        OR: [{ createdById: userId }, { members: { some: { userId } } }],
      },
      include: {
        createdBy: {
          select: USER_SELECT,
        },
        members: {
          select: {
            userId: true,
            role: true,
            user: {
              select: USER_SELECT,
            },
          },
        },
        labels: { include: { label: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
    return raw.map(mapProjectWithMembers);
  }

  async permanentDeleteProject(projectId: string) {
    return this.prisma.project.delete({ where: { id: projectId } });
  }
}

export { CoreRepository as ProjectRepository };
