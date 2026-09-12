import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { AssignmentRepository } from './assignment.repository';
import {
  AssignTaskResult,
  BulkAssignResult,
  ELIGIBLE_ASSIGNEE_ROLES,
} from './types/assignment.types';
import { BulkAssignTaskDto, SetAssigneesDto, AddAssigneeDto } from './dto/assignment.dto';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class AssignmentService {
  constructor(
    private readonly assignmentRepository: AssignmentRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Assigns or unassigns a work item / task to a project member.
   * Business rules:
   * 1. Assignee must be a verified project member.
   * 2. Assignee must have role 'admin' or 'contributor' (viewers and commenters cannot be assigned).
   * 3. Passing null/empty assigneeId unassigns the task.
   */
  async assignTask(
    projectId: string,
    taskId: string,
    assigneeId: string | null | undefined,
    actorId?: string,
  ): Promise<AssignTaskResult> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    const normalizedAssigneeId = assigneeId ? assigneeId.trim() : null;

    if (normalizedAssigneeId) {
      const member = await this.assignmentRepository.findProjectMember(
        projectId,
        normalizedAssigneeId,
      );

      if (!member) {
        throw new BadRequestException(
          'Assignee is not a member of this project',
        );
      }

      if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
        throw new BadRequestException(
          `Cannot assign task to member with role "${member.role}". Only active "${ELIGIBLE_ASSIGNEE_ROLES.join(', ')}" members can be assigned tasks.`,
        );
      }
    }

    const previousAssigneeId = task.assigneeId;

    // Idempotent check
    if (previousAssigneeId === normalizedAssigneeId) {
      return {
        task,
        previousAssigneeId,
        newAssigneeId: normalizedAssigneeId,
      };
    }

    const updatedTask = await this.assignmentRepository.assignTask(
      task.id,
      normalizedAssigneeId,
    );

    await this.invalidateTaskCache(projectId, task.id, task.identifier);

    const workspaceId = task.project?.workspaceId || '';

    if (this.eventEmitter) {
      if (normalizedAssigneeId) {
        this.eventEmitter.emit('task.assigned', {
          entityType: 'task',
          entityId: task.id,
          verb: 'assigned',
          field: 'assigneeId',
          oldValue: previousAssigneeId || undefined,
          newValue: normalizedAssigneeId,
          actorId: actorId || '',
          workspaceId,
          projectId,
        });
      } else {
        this.eventEmitter.emit('task.unassigned', {
          entityType: 'task',
          entityId: task.id,
          verb: 'unassigned',
          field: 'assigneeId',
          oldValue: previousAssigneeId || undefined,
          newValue: undefined,
          actorId: actorId || '',
          workspaceId,
          projectId,
        });
      }
    }

    return {
      task: updatedTask,
      previousAssigneeId,
      newAssigneeId: normalizedAssigneeId,
    };
  }

  /**
   * Unassigns a work item / task.
   */
  async unassignTask(
    projectId: string,
    taskId: string,
    actorId?: string,
  ): Promise<AssignTaskResult> {
    return this.assignTask(projectId, taskId, null, actorId);
  }

  /**
   * Self-assigns the caller to a task ("Join Issue" action).
   */
  async joinTask(
    projectId: string,
    taskId: string,
    userId: string,
  ): Promise<AssignTaskResult> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    if (task.assigneeId === userId) {
      throw new BadRequestException('You are already assigned to this task');
    }

    const member = await this.assignmentRepository.findProjectMember(
      projectId,
      userId,
    );
    if (!member || !ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
      throw new ForbiddenException(
        'You must be an active project admin or contributor to join this task',
      );
    }

    return this.assignTask(projectId, taskId, userId, userId);
  }

  /**
   * Removes caller from being the assignee of a task ("Leave Issue" action).
   */
  async leaveTask(
    projectId: string,
    taskId: string,
    userId: string,
  ): Promise<AssignTaskResult> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    if (task.assigneeId !== userId) {
      throw new BadRequestException(
        'You are not currently assigned to this task',
      );
    }

    return this.assignTask(projectId, taskId, null, userId);
  }

  /**
   * Bulk-assigns or bulk-unassigns multiple tasks within a project.
   */
  async bulkAssign(
    projectId: string,
    bulkAssignTaskDto: BulkAssignTaskDto,
    actorId?: string,
  ): Promise<BulkAssignResult> {
    const rawTargetId =
      bulkAssignTaskDto.assigneeId !== undefined
        ? bulkAssignTaskDto.assigneeId
        : bulkAssignTaskDto.assignee;
    const normalizedAssigneeId = rawTargetId ? rawTargetId.trim() : null;

    if (normalizedAssigneeId) {
      const member = await this.assignmentRepository.findProjectMember(
        projectId,
        normalizedAssigneeId,
      );

      if (!member) {
        throw new BadRequestException(
          'Assignee is not a member of this project',
        );
      }

      if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
        throw new BadRequestException(
          `Cannot assign tasks to member with role "${member.role}". Only active "${ELIGIBLE_ASSIGNEE_ROLES.join(', ')}" members can be assigned tasks.`,
        );
      }
    }

    const updatedCount = await this.assignmentRepository.bulkAssignTasks(
      projectId,
      bulkAssignTaskDto.taskIds,
      normalizedAssigneeId,
    );

    if (this.cache) {
      await Promise.all(
        bulkAssignTaskDto.taskIds.map((id: string) => this.cache!.del(WORK_ITEM_REDIS_KEYS.task(id))),
      );
      await this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId));
    }

    return {
      updatedCount,
      taskIds: bulkAssignTaskDto.taskIds,
      assigneeId: normalizedAssigneeId,
    };
  }

  /**
   * Returns list of eligible assignees for this project (admins and contributors).
   */
  async getEligibleAssignees(projectId: string) {
    const members = await this.assignmentRepository.findEligibleAssignees(projectId);
    return {
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt,
        user: member.user,
      })),
    };
  }

  /**
   * Resolves the default assignee for a project if configured in settings.
   * Verifies that the default assignee is still an active eligible member.
   */
  async resolveDefaultAssignee(projectId: string): Promise<string | null> {
    const settings = await this.assignmentRepository.getProjectSettings(projectId);
    if (!settings || !settings.defaultAssigneeId) {
      return null;
    }

    const member = await this.assignmentRepository.findProjectMember(
      projectId,
      settings.defaultAssigneeId,
    );

    if (!member || !ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
      return null;
    }

    return settings.defaultAssigneeId;
  }

  private async invalidateTaskCache(
    projectId: string,
    taskId: string,
    identifier?: string | null,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.task(taskId)),
        ...(identifier
          ? [this.cache.del(WORK_ITEM_REDIS_KEYS.task(identifier))]
          : []),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectTasks(projectId)),
      ]);
    } catch {
      // Best effort cache invalidation
    }
  }

  // ── MULTI-ASSIGNEE METHODS ──────────────────────────────────────────────────

  /**
   * Get the full list of assignees on a work item (primary + co-assignees).
   * Returns resolved user objects for each assignee ID.
   */
  async getAssignees(
    projectId: string,
    taskId: string,
  ): Promise<{ assignees: { id: string; name: string | null; email: string | null; avatar: string | null }[] }> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    const assigneeIds: string[] = Array.isArray(task.assigneeIds)
      ? (task.assigneeIds as string[])
      : task.assigneeId
        ? [task.assigneeId]
        : [];

    if (assigneeIds.length === 0) return { assignees: [] };

    const assignees = await this.assignmentRepository.findUsersByIds(assigneeIds);
    return { assignees };
  }

  /**
   * Replace the full assignees list on a work item.
   * First entry becomes the primary assignee (assigneeId).
   * Validates all provided IDs are eligible project members.
   */
  async setAssignees(
    projectId: string,
    taskId: string,
    setAssigneesDto: SetAssigneesDto,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    // Validate all assignees
    for (const assigneeUserId of setAssigneesDto.assigneeIds) {
      const member = await this.assignmentRepository.findProjectMember(projectId, assigneeUserId);
      if (!member) {
        throw new BadRequestException(`User ${assigneeUserId} is not a member of this project`);
      }
      if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
        throw new BadRequestException(
          `User ${assigneeUserId} has role "${member.role}" and cannot be assigned tasks`,
        );
      }
    }

    const primaryAssigneeId = setAssigneesDto.assigneeIds[0] ?? null;
    const deduped: string[] = Array.from(new Set(setAssigneesDto.assigneeIds));

    await this.assignmentRepository.setAssigneeIds(taskId, deduped, primaryAssigneeId);
    await this.invalidateTaskCache(projectId, task.id, task.identifier);

    this.eventEmitter?.emit('task.assignees.set', {
      taskId,
      assigneeIds: deduped,
      primaryAssigneeId,
      actorId,
      projectId,
    });

    return { assignees: deduped, primaryAssigneeId };
  }

  /**
   * Add a single co-assignee to a work item without removing existing ones.
   * Idempotent — adding an already-existing assignee is a no-op.
   */
  async addAssignee(
    projectId: string,
    taskId: string,
    addAssigneeDto: AddAssigneeDto,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    const member = await this.assignmentRepository.findProjectMember(projectId, addAssigneeDto.assigneeId);
    if (!member) {
      throw new BadRequestException('User is not a member of this project');
    }
    if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
      throw new BadRequestException(
        `User has role "${member.role}" and cannot be assigned tasks`,
      );
    }

    const existing: string[] = Array.isArray(task.assigneeIds)
      ? (task.assigneeIds as string[])
      : task.assigneeId
        ? [task.assigneeId]
        : [];

    if (existing.includes(addAssigneeDto.assigneeId)) {
      // Idempotent — already assigned
      return { assignees: existing, primaryAssigneeId: existing[0] ?? null };
    }

    const updated = [...existing, addAssigneeDto.assigneeId];
    const primaryAssigneeId = updated[0] ?? null;

    await this.assignmentRepository.setAssigneeIds(taskId, updated, primaryAssigneeId);
    await this.invalidateTaskCache(projectId, task.id, task.identifier);

    this.eventEmitter?.emit('task.assignee.added', {
      taskId,
      assigneeId: addAssigneeDto.assigneeId,
      actorId,
      projectId,
    });

    return { assignees: updated, primaryAssigneeId };
  }

  /**
   * Remove a single co-assignee from a work item.
   * If the removed user was the primary assignee, the next in the list becomes primary.
   */
  async removeAssignee(
    projectId: string,
    taskId: string,
    targetUserId: string,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const task = await this.assignmentRepository.findTaskWithProject(taskId);
    if (!task || task.projectId !== projectId) {
      throw new NotFoundException('Task not found in this project');
    }

    const existing: string[] = Array.isArray(task.assigneeIds)
      ? (task.assigneeIds as string[])
      : task.assigneeId
        ? [task.assigneeId]
        : [];

    const updated = existing.filter((id) => id !== targetUserId);
    const primaryAssigneeId = updated[0] ?? null;

    await this.assignmentRepository.setAssigneeIds(taskId, updated, primaryAssigneeId);
    await this.invalidateTaskCache(projectId, task.id, task.identifier);

    this.eventEmitter?.emit('task.assignee.removed', {
      taskId,
      assigneeId: targetUserId,
      actorId,
      projectId,
    });

    return { assignees: updated, primaryAssigneeId };
  }
}

