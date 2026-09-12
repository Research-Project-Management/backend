import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import {
  buildWorkspaceIdentifierWhere,
  isUuid,
} from '@/core/utils/tenant.util';
import { Prisma, Task } from '@prisma/client';
import {
  IWorkItemRepository,
  WorkItemWithRelations,
  WorkItemFilterOptions,
  WorkItemAttachments,
  USER_MINIMAL_SELECT,
  CYCLE_SELECT,
  SUBTASK_SELECT,
} from './types/work-item.types';
import { deriveProjectIdentifierPrefix } from './utils/work-item.util';

@Injectable()
export class WorkItemRepository implements IWorkItemRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async nextProjectTaskIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }> {
    const project = await this.prismaService.project.update({
      where: { id: projectId },
      data: { taskSequence: { increment: 1 } },
      select: { name: true, identifier: true, taskSequence: true },
    });

    const prefix = deriveProjectIdentifierPrefix(
      project.identifier,
      project.name,
    );

    return {
      identifier: `${prefix}-${project.taskSequence}`,
      sequenceNumber: project.taskSequence,
    };
  }

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prismaService.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findWorkspaceTasks(workspaceId: string) {
    const workspace = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      workspace?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return [];

    return this.prismaService.task.findMany({
      where: {
        project: { workspaceId: canonicalWorkspaceId, deletedAt: null },
        deletedAt: null,
        archivedAt: null,
      },
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: {
          where: { deletedAt: null },
          select: SUBTASK_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true, workspaceId: true } },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findProjectTasks(
    projectId: string,
    filter?: string | WorkItemFilterOptions,
  ): Promise<WorkItemWithRelations[]> {
    let canonicalProjectId = projectId;
    if (!isUuid(canonicalProjectId)) {
      const project = await this.prismaService.project
        .findFirst({
          where: {
            identifier: { equals: canonicalProjectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true },
        })
        .catch(() => null);
      if (!project) return [];
      canonicalProjectId = project.id;
    }

    const where: Prisma.TaskWhereInput = {
      projectId: canonicalProjectId,
      deletedAt: null,
    };

    if (filter && typeof filter === 'object' && filter.archived === true) {
      where.archivedAt = { not: null };
    } else {
      where.archivedAt = null;
    }

    let take: number | undefined;
    let skip: number | undefined;

    if (typeof filter === 'string') {
      if (filter === 'none' || filter === 'null' || filter === 'unassigned') {
        where.cycleId = null;
      } else if (isUuid(filter)) {
        where.cycleId = filter;
      }
    } else if (filter) {
      if (filter.cycleId !== undefined) {
        if (
          filter.cycleId === 'none' ||
          filter.cycleId === 'null' ||
          filter.cycleId === 'unassigned'
        ) {
          where.cycleId = null;
        } else if (filter.cycleId === null || isUuid(filter.cycleId)) {
          where.cycleId = filter.cycleId;
        }
      }
      if (filter.columnId) where.columnId = filter.columnId;
      if (filter.priority) where.priority = filter.priority;
      if (filter.assigneeId !== undefined) {
        if (
          filter.assigneeId === 'unassigned' ||
          filter.assigneeId === 'none' ||
          filter.assigneeId === 'null'
        ) {
          where.assigneeId = null;
        } else if (filter.assigneeId === null || isUuid(filter.assigneeId)) {
          where.assigneeId = filter.assigneeId;
        }
      }
      if (filter.parentTaskId !== undefined) {
        if (filter.parentTaskId === 'none' || filter.parentTaskId === 'null') {
          where.parentTaskId = null;
        } else if (
          filter.parentTaskId === null ||
          isUuid(filter.parentTaskId)
        ) {
          where.parentTaskId = filter.parentTaskId;
        }
      }
      if (filter.completed !== undefined) {
        where.completed = filter.completed;
      }
      if (filter.search?.trim()) {
        const query = filter.search.trim();
        where.OR = [
          { title: { contains: query, mode: 'insensitive' } },
          { identifier: { contains: query, mode: 'insensitive' } },
        ];
      }
      if (filter.limit) take = filter.limit;
      if (filter.offset) skip = filter.offset;
    }

    return this.prismaService.task.findMany({
      where,
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: {
          where: { deletedAt: null },
          select: SUBTASK_SELECT,
          orderBy: { rank: 'asc' },
        },
        project: { select: { id: true, workspaceId: true } },
      },
      orderBy: { rank: 'asc' },
      ...(take ? { take } : {}),
      ...(skip ? { skip } : {}),
    });
  }

  async findProjectWithColumns(projectId: string) {
    return this.prismaService.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, taskColumns: true },
    });
  }

  async findTaskById(taskId: string): Promise<WorkItemWithRelations | null> {
    if (!isUuid(taskId)) {
      return this.prismaService.task.findFirst({
        where: { identifier: taskId, deletedAt: null },
        include: {
          assignee: { select: USER_MINIMAL_SELECT },
          cycle: { select: CYCLE_SELECT },
          parentTask: { select: { id: true, title: true, identifier: true } },
          subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
          project: { select: { id: true, workspaceId: true } },
        },
      });
    }

    return this.prismaService.task.findFirst({
      where: { id: taskId, deletedAt: null },
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async findTaskByIdentifier(
    projectId: string,
    identifier: string,
  ): Promise<WorkItemWithRelations | null> {
    return this.prismaService.task.findFirst({
      where: { projectId, identifier, deletedAt: null },
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async countColumnTasks(projectId: string, columnId: string): Promise<number> {
    return this.prismaService.task.count({
      where: { projectId, columnId, deletedAt: null, archivedAt: null },
    });
  }

  async createTask(
    data: Prisma.TaskCreateInput | Prisma.TaskUncheckedCreateInput,
  ): Promise<WorkItemWithRelations> {
    return this.prismaService.task.create({
      data: data as Prisma.TaskCreateInput,
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async updateTask(
    taskId: string,
    data: Prisma.TaskUpdateInput | Prisma.TaskUncheckedUpdateInput,
  ): Promise<WorkItemWithRelations> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: data,
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async softDeleteTask(taskId: string): Promise<Task> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: { deletedAt: new Date() },
    });
  }

  async restoreTask(taskId: string): Promise<Task> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: { deletedAt: null },
    });
  }

  async deleteTask(taskId: string): Promise<Task> {
    return this.prismaService.task.delete({
      where: { id: taskId },
    });
  }

  async findColumnTasks(projectId: string, columnId: string) {
    return this.prismaService.task.findMany({
      where: { projectId, columnId, deletedAt: null },
      orderBy: { rank: 'asc' },
    });
  }

  async updateTasksRank(
    updates: Array<{
      id: string;
      rank: number;
      columnId?: string;
      completed?: boolean;
    }>,
  ): Promise<Task[]> {
    const validUpdates = updates.filter((updateItem) => isUuid(updateItem.id));
    if (validUpdates.length === 0) return [];
    return this.prismaService.$transaction(
      validUpdates.map((updateItem) =>
        this.prismaService.task.update({
          where: { id: updateItem.id },
          data: {
            rank: updateItem.rank,
            ...(updateItem.columnId && { columnId: updateItem.columnId }),
            ...(updateItem.completed !== undefined && { completed: updateItem.completed }),
          },
        }),
      ),
    );
  }

  async bulkUpdateTasks(
    projectId: string,
    taskIds: string[],
    data: Prisma.TaskUpdateManyMutationInput,
  ) {
    const validIds = taskIds.filter(isUuid);
    if (validIds.length === 0 || !projectId || !isUuid(projectId)) {
      return { count: 0 };
    }
    return this.prismaService.task.updateMany({
      where: {
        id: { in: validIds },
        projectId,
      },
      data,
    });
  }

  async bulkDeleteTasks(projectId: string, taskIds: string[]) {
    const validIds = taskIds.filter(isUuid);
    if (validIds.length === 0) return { count: 0 };
    return this.prismaService.task.updateMany({
      where: {
        id: { in: validIds },
        ...(projectId && isUuid(projectId) ? { projectId } : {}),
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async findProjectMemberRole(
    projectId: string,
    userId: string,
  ): Promise<string | null> {
    const project = isUuid(projectId)
      ? await this.prismaService.project.findUnique({
          where: { id: projectId },
          select: { id: true, workspaceId: true },
        })
      : await this.prismaService.project.findFirst({
          where: {
            identifier: { equals: projectId, mode: 'insensitive' },
            deletedAt: null,
          },
          select: { id: true, workspaceId: true },
        });

    if (!project) return null;

    // Check workspace owner/admin super-permission
    const workspace = await this.prismaService.workspace.findFirst({
      where: {
        id: project.workspaceId,
      },
      select: { ownerId: true, createdById: true },
    });

    if (
      workspace &&
      (workspace.ownerId === userId || workspace.createdById === userId)
    ) {
      return 'admin';
    }

    const member = await this.prismaService.projectMember.findFirst({
      where: {
        projectId: project.id,
        userId,
      },
      select: { role: true },
    });

    return member?.role ?? null;
  }

  async updateAttachments(
    taskId: string,
    attachments: WorkItemAttachments,
  ): Promise<Task> {
    return this.prismaService.task.findUniqueOrThrow({
      where: { id: taskId },
    });
  }

  async disconnectParentTask(taskId: string): Promise<WorkItemWithRelations> {
    return this.prismaService.task.update({
      where: { id: taskId },
      data: { parentTask: { disconnect: true } },
      include: {
        assignee: {
          select: USER_MINIMAL_SELECT,
        },
        cycle: {
          select: CYCLE_SELECT,
        },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: {
          select: SUBTASK_SELECT,
        },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }
}

// Backward compatibility alias
export const TaskRepository = WorkItemRepository;
export type TaskRepository = WorkItemRepository;
