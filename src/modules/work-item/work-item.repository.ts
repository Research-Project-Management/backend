import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
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
      where: {
        OR: [
          { id: workspaceIdOrSlug },
          { slug: workspaceIdOrSlug },
          { url: workspaceIdOrSlug },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async findWorkspaceTasks(workspaceId: string) {
    const ws = await this.resolveWorkspace(workspaceId);
    const targetId = ws?.id || workspaceId;
    return this.prisma.task.findMany({
      where: {
        project: { workspaceId: targetId, deletedAt: null },
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
    const where: Prisma.TaskWhereInput = {
      projectId,
      deletedAt: null,
    };

    let take: number | undefined;
    let skip: number | undefined;

    if (typeof filter === 'string') {
      where.cycleId = filter;
    } else if (filter) {
      if (filter.cycleId) where.cycleId = filter.cycleId;
      if (filter.columnId) where.columnId = filter.columnId;
      if (filter.priority) where.priority = filter.priority;
      if (filter.assigneeId) where.assigneeId = filter.assigneeId;
      if (filter.parentTaskId !== undefined) {
        where.parentTaskId = filter.parentTaskId;
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
    return this.prisma.$transaction(
      updates.map((u) =>
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
    return this.prisma.task.updateMany({
      where: {
        id: { in: taskIds },
        ...(projectId ? { projectId } : {}),
      },
      data,
    });
  }
}

// Backward compatibility alias
export const TaskRepository = WorkItemRepository;
export type TaskRepository = WorkItemRepository;
