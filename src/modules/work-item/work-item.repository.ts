import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { buildWorkspaceIdentifierWhere, isUuid } from '@/core/utils/tenant.util';
import { Prisma, Task } from '@prisma/client';
import {
  IWorkItemRepository,
  WorkItemWithRelations,
  WorkItemFilterOptions,
  USER_MINIMAL_SELECT,
  CYCLE_SELECT,
  SUBTASK_SELECT,
} from './types/work-item.types';
import { deriveProjectIdentifierPrefix } from './utils/work-item.util';

@Injectable()
export class WorkItemRepository implements IWorkItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  async nextProjectTaskIdentifier(
    projectId: string,
  ): Promise<{ identifier: string; sequenceNumber: number }> {
    const project = await this.prisma.project.update({
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
    return this.prisma.workspace.findFirst({
      where: buildWorkspaceIdentifierWhere(workspaceIdOrSlug),
      select: { id: true },
    });
  }

  async findWorkspaceTasks(workspaceId: string) {
    const ws = await this.resolveWorkspace(workspaceId);
    const canonicalWorkspaceId =
      ws?.id || (isUuid(workspaceId) ? workspaceId : null);
    if (!canonicalWorkspaceId) return [];

    return this.prisma.task.findMany({
      where: {
        project: { workspaceId: canonicalWorkspaceId, deletedAt: null },
        deletedAt: null,
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
      const proj = await this.prisma.project
        .findFirst({
          where: { identifier: { equals: canonicalProjectId, mode: 'insensitive' }, deletedAt: null },
          select: { id: true },
        })
        .catch(() => null);
      if (!proj) return [];
      canonicalProjectId = proj.id;
    }

    const where: Prisma.TaskWhereInput = {
      projectId: canonicalProjectId,
      deletedAt: null,
    };

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
        if (filter.cycleId === 'none' || filter.cycleId === 'null' || filter.cycleId === 'unassigned') {
          where.cycleId = null;
        } else if (filter.cycleId === null || isUuid(filter.cycleId)) {
          where.cycleId = filter.cycleId;
        }
      }
      if (filter.columnId) where.columnId = filter.columnId;
      if (filter.priority) where.priority = filter.priority;
      if (filter.assigneeId !== undefined) {
        if (filter.assigneeId === 'unassigned' || filter.assigneeId === 'none' || filter.assigneeId === 'null') {
          where.assigneeId = null;
        } else if (filter.assigneeId === null || isUuid(filter.assigneeId)) {
          where.assigneeId = filter.assigneeId;
        }
      }
      if (filter.parentTaskId !== undefined) {
        if (filter.parentTaskId === 'none' || filter.parentTaskId === 'null') {
          where.parentTaskId = null;
        } else if (filter.parentTaskId === null || isUuid(filter.parentTaskId)) {
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

    return this.prisma.task.findMany({
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
    return this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, name: true, taskColumns: true },
    });
  }

  async findTaskById(taskId: string): Promise<WorkItemWithRelations | null> {
    if (!isUuid(taskId)) {
      return this.prisma.task.findFirst({
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

    return this.prisma.task.findFirst({
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
    return this.prisma.task.findFirst({
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
    return this.prisma.task.count({
      where: { projectId, columnId, deletedAt: null },
    });
  }

  async createTask(
    data: Prisma.TaskCreateInput | Prisma.TaskUncheckedCreateInput,
  ): Promise<WorkItemWithRelations> {
    return this.prisma.task.create({
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
    return this.prisma.task.update({
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
    return this.prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: new Date() },
    });
  }

  async restoreTask(taskId: string): Promise<Task> {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { deletedAt: null },
    });
  }

  async deleteTask(taskId: string): Promise<Task> {
    return this.prisma.task.delete({
      where: { id: taskId },
    });
  }

  async assignTask(
    taskId: string,
    assigneeId: string | null,
  ): Promise<WorkItemWithRelations> {
    return this.prisma.task.update({
      where: { id: taskId },
      data: { assigneeId },
      include: {
        assignee: { select: USER_MINIMAL_SELECT },
        cycle: { select: CYCLE_SELECT },
        parentTask: { select: { id: true, title: true, identifier: true } },
        subtasks: { select: SUBTASK_SELECT, orderBy: { rank: 'asc' } },
        project: { select: { id: true, workspaceId: true } },
      },
    });
  }

  async findColumnTasks(projectId: string, columnId: string) {
    return this.prisma.task.findMany({
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
    const validUpdates = updates.filter((u) => isUuid(u.id));
    if (validUpdates.length === 0) return [];
    return this.prisma.$transaction(
      validUpdates.map((u) =>
        this.prisma.task.update({
          where: { id: u.id },
          data: {
            rank: u.rank,
            ...(u.columnId && { columnId: u.columnId }),
            ...(u.completed !== undefined && { completed: u.completed }),
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
    if (validIds.length === 0) return { count: 0 };
    return this.prisma.task.updateMany({
      where: {
        id: { in: validIds },
        ...(projectId && isUuid(projectId) ? { projectId } : {}),
      },
      data,
    });
  }
}

// Backward compatibility alias
export const TaskRepository = WorkItemRepository;
export type TaskRepository = WorkItemRepository;
