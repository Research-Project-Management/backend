import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { AssignmentRepository } from './assignment.repository';
import {
  AssignWorkItemResult,
  BulkAssignResult,
  ELIGIBLE_ASSIGNEE_ROLES,
} from './types/assignment.types';
import {
  BulkAssignWorkItemDto,
  SetAssigneesDto,
  AddAssigneeDto,
} from './dto/assignment.dto';
import { WORK_ITEM_REDIS_KEYS } from '../core/constants/redis-keys.constant';

@Injectable()
export class AssignmentService {
  constructor(
    private readonly assignmentRepository: AssignmentRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * Assigns or unassigns a work item to a project member.
   * Business rules:
   * 1. Assignee must be a verified project member.
   * 2. Assignee must have execution role ('owner', 'coordinator', 'contributor'). Reviewers cannot be assigned.
   * 3. Passing null/empty assigneeId unassigns the work item.
   */
  async assignWorkItem(
    projectId: string,
    workItemId: string,
    assigneeId: string | null | undefined,
    actorId?: string,
  ): Promise<AssignWorkItemResult> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
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
          `Cannot assign WorkItem to member with role "${member.role}". Only active "${ELIGIBLE_ASSIGNEE_ROLES.join(', ')}" members can be assigned work items.`,
        );
      }
    }

    const previousAssigneeId = item.assigneeId;

    // Idempotent check
    if (previousAssigneeId === normalizedAssigneeId) {
      return {
        workItem: item,
        previousAssigneeId,
        newAssigneeId: normalizedAssigneeId,
      };
    }

    const updatedItem = await this.assignmentRepository.assignWorkItem(
      item.id,
      normalizedAssigneeId,
    );

    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    if (this.eventEmitter) {
      if (normalizedAssigneeId) {
        const payload = {
          entityType: 'work_item',
          entityId: item.id,
          workItemId: item.id,
          verb: 'assigned',
          field: 'assigneeId',
          oldValue: previousAssigneeId || undefined,
          newValue: normalizedAssigneeId,
          actorId: actorId || '',
          projectId,
        };
        this.eventEmitter.emit('work-item.assigned', payload);
        this.eventEmitter.emit('work-item.updated', payload);
      } else {
        const payload = {
          entityType: 'work_item',
          entityId: item.id,
          workItemId: item.id,
          verb: 'unassigned',
          field: 'assigneeId',
          oldValue: previousAssigneeId || undefined,
          newValue: undefined,
          actorId: actorId || '',
          projectId,
        };
        this.eventEmitter.emit('work-item.unassigned', payload);
        this.eventEmitter.emit('work-item.updated', payload);
      }
    }

    return {
      workItem: updatedItem,
      previousAssigneeId,
      newAssigneeId: normalizedAssigneeId,
    };
  }

  /**
   * Unassigns a work item.
   */
  async unassignWorkItem(
    projectId: string,
    workItemId: string,
    actorId?: string,
  ): Promise<AssignWorkItemResult> {
    return this.assignWorkItem(projectId, workItemId, null, actorId);
  }

  /**
   * Self-assigns the caller to a work item ("Join Issue" action).
   */
  async joinWorkItem(
    projectId: string,
    workItemId: string,
    userId: string,
  ): Promise<AssignWorkItemResult> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    if (item.assigneeId === userId) {
      throw new BadRequestException(
        'You are already assigned to this work item',
      );
    }

    const member = await this.assignmentRepository.findProjectMember(
      projectId,
      userId,
    );
    if (!member || !ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
      throw new ForbiddenException(
        'You must be an active project owner or contributor to join this work item',
      );
    }

    return this.assignWorkItem(projectId, workItemId, userId, userId);
  }

  /**
   * Removes caller from being the assignee of a work item ("Leave Issue" action).
   */
  async leaveWorkItem(
    projectId: string,
    workItemId: string,
    userId: string,
  ): Promise<AssignWorkItemResult> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    if (item.assigneeId !== userId) {
      throw new BadRequestException(
        'You are not currently assigned to this work item',
      );
    }

    return this.assignWorkItem(projectId, workItemId, null, userId);
  }

  /**
   * Bulk-assigns or bulk-unassigns multiple work items within a project.
   */
  async bulkAssign(
    projectId: string,
    bulkAssignWorkItemDto: BulkAssignWorkItemDto,
    actorId?: string,
  ): Promise<BulkAssignResult> {
    const rawTargetId =
      bulkAssignWorkItemDto.assigneeId !== undefined
        ? bulkAssignWorkItemDto.assigneeId
        : bulkAssignWorkItemDto.assignee;
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
          `Cannot assign work items to member with role "${member.role}". Only active "${ELIGIBLE_ASSIGNEE_ROLES.join(', ')}" members can be assigned work items.`,
        );
      }
    }

    const rawItemIds = bulkAssignWorkItemDto.workItemIds || [];

    if (rawItemIds.length === 0) {
      throw new BadRequestException(
        'At least one WorkItem ID must be provided',
      );
    }

    const updatedCount = await this.assignmentRepository.bulkAssignWorkItems(
      projectId,
      rawItemIds,
      normalizedAssigneeId,
    );

    if (this.cache) {
      await Promise.all(
        rawItemIds.map((id: string) =>
          this.cache!.del(WORK_ITEM_REDIS_KEYS.workItem(id)),
        ),
      );
      await this.cache.del(WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId));
      await this.cache.del(`flux:wi:proj:${projectId}`);
    }

    return {
      updatedCount,
      workItemIds: rawItemIds,
      assigneeId: normalizedAssigneeId,
    };
  }

  /**
   * Returns list of eligible assignees for this project (owners and contributors).
   */
  async getEligibleAssignees(projectId: string) {
    const members =
      await this.assignmentRepository.findEligibleAssignees(projectId);
    return {
      members: members.map((member) => ({
        id: member.userId,
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
    const settings =
      await this.assignmentRepository.getProjectSettings(projectId);
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

  private async invalidateWorkItemCache(
    projectId: string,
    workItemId: string,
    identifier?: string | null,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await Promise.all([
        this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(workItemId)),
        ...(identifier
          ? [this.cache.del(WORK_ITEM_REDIS_KEYS.workItem(identifier))]
          : []),
        this.cache.del(WORK_ITEM_REDIS_KEYS.projectWorkItems(projectId)),
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
    workItemId: string,
  ): Promise<{
    assignees: {
      id: string;
      name: string | null;
      email: string | null;
      avatar: string | null;
    }[];
  }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    const assigneeIds: string[] = Array.isArray(item.assigneeIds)
      ? (item.assigneeIds as string[])
      : item.assigneeId
        ? [item.assigneeId]
        : [];

    if (assigneeIds.length === 0) return { assignees: [] };

    const assignees =
      await this.assignmentRepository.findUsersByIds(assigneeIds);
    return { assignees };
  }

  /**
   * Replace the full assignees list on a work item.
   * First entry becomes the primary assignee (assigneeId).
   * Validates all provided IDs are eligible project members.
   */
  async setAssignees(
    projectId: string,
    workItemId: string,
    setAssigneesDto: SetAssigneesDto,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    // Validate all assignees
    for (const assigneeUserId of setAssigneesDto.assigneeIds) {
      const member = await this.assignmentRepository.findProjectMember(
        projectId,
        assigneeUserId,
      );
      if (!member) {
        throw new BadRequestException(
          `User ${assigneeUserId} is not a member of this project`,
        );
      }
      if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
        throw new BadRequestException(
          `User ${assigneeUserId} has role "${member.role}" and cannot be assigned work items`,
        );
      }
    }

    const primaryAssigneeId = setAssigneesDto.assigneeIds[0] ?? null;
    const deduped: string[] = Array.from(new Set(setAssigneesDto.assigneeIds));

    await this.assignmentRepository.setAssigneeIds(
      workItemId,
      deduped,
      primaryAssigneeId,
    );
    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    const assigneesPayload = {
      entityType: 'work_item',
      entityId: workItemId,
      workItemId,
      assigneeIds: deduped,
      primaryAssigneeId,
      actorId,
      projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.assignees.set', assigneesPayload);
    this.eventEmitter?.emit('work-item.updated', assigneesPayload);

    return { assignees: deduped, primaryAssigneeId };
  }

  /**
   * Add a single co-assignee to a work item without removing existing ones.
   * Idempotent — adding an already-existing assignee is a no-op.
   */
  async addAssignee(
    projectId: string,
    workItemId: string,
    addAssigneeDto: AddAssigneeDto,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    const member = await this.assignmentRepository.findProjectMember(
      projectId,
      addAssigneeDto.assigneeId,
    );
    if (!member) {
      throw new BadRequestException('User is not a member of this project');
    }
    if (!ELIGIBLE_ASSIGNEE_ROLES.includes(member.role)) {
      throw new BadRequestException(
        `User has role "${member.role}" and cannot be assigned work items`,
      );
    }

    const existing: string[] = Array.isArray(item.assigneeIds)
      ? (item.assigneeIds as string[])
      : item.assigneeId
        ? [item.assigneeId]
        : [];

    if (existing.includes(addAssigneeDto.assigneeId)) {
      // Idempotent — already assigned
      return { assignees: existing, primaryAssigneeId: existing[0] ?? null };
    }

    const updated = [...existing, addAssigneeDto.assigneeId];
    const primaryAssigneeId = updated[0] ?? null;

    await this.assignmentRepository.setAssigneeIds(
      workItemId,
      updated,
      primaryAssigneeId,
    );
    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    const addPayload = {
      entityType: 'work_item',
      entityId: workItemId,
      workItemId,
      assigneeId: addAssigneeDto.assigneeId,
      actorId,
      projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.assignee.added', addPayload);
    this.eventEmitter?.emit('work-item.updated', addPayload);

    return { assignees: updated, primaryAssigneeId };
  }

  /**
   * Remove a single co-assignee from a work item.
   * If the removed user was the primary assignee, the next in the list becomes primary.
   */
  async removeAssignee(
    projectId: string,
    workItemId: string,
    targetUserId: string,
    actorId?: string,
  ): Promise<{ assignees: string[]; primaryAssigneeId: string | null }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    const existing: string[] = Array.isArray(item.assigneeIds)
      ? (item.assigneeIds as string[])
      : item.assigneeId
        ? [item.assigneeId]
        : [];

    const updated = existing.filter((id) => id !== targetUserId);
    const primaryAssigneeId = updated[0] ?? null;

    await this.assignmentRepository.setAssigneeIds(
      workItemId,
      updated,
      primaryAssigneeId,
    );
    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    const removePayload = {
      entityType: 'work_item',
      entityId: workItemId,
      workItemId,
      assigneeId: targetUserId,
      actorId,
      projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.assignee.removed', removePayload);
    this.eventEmitter?.emit('work-item.updated', removePayload);

    return { assignees: updated, primaryAssigneeId };
  }

  /**
   * Subscribe current user to notifications for a work item.
   */
  async subscribeMe(
    projectId: string,
    workItemId: string,
    userId: string,
  ): Promise<{ subscribers: string[] }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    const currentSubscribers: string[] = Array.isArray(
      (item as any).subscriberIds,
    )
      ? ((item as any).subscriberIds as string[])
      : [];

    if (currentSubscribers.includes(userId)) {
      return { subscribers: currentSubscribers };
    }

    const updated = [...currentSubscribers, userId];
    await this.assignmentRepository.setSubscriberIds(item.id, updated);
    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    const payload = {
      entityType: 'work_item',
      entityId: item.id,
      workItemId: item.id,
      subscriberIds: updated,
      actorId: userId,
      projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.updated', payload);

    return { subscribers: updated };
  }

  /**
   * Unsubscribe current user from notifications for a work item.
   */
  async unsubscribeMe(
    projectId: string,
    workItemId: string,
    userId: string,
  ): Promise<{ subscribers: string[] }> {
    const item =
      await this.assignmentRepository.findWorkItemWithProject(workItemId);
    if (!item || item.projectId !== projectId) {
      throw new NotFoundException('Work item not found in this project');
    }

    const currentSubscribers: string[] = Array.isArray(
      (item as any).subscriberIds,
    )
      ? ((item as any).subscriberIds as string[])
      : [];

    const updated = currentSubscribers.filter((id) => id !== userId);
    await this.assignmentRepository.setSubscriberIds(item.id, updated);
    await this.invalidateWorkItemCache(projectId, item.id, item.identifier);

    const payload = {
      entityType: 'work_item',
      entityId: item.id,
      workItemId: item.id,
      subscriberIds: updated,
      actorId: userId,
      projectId,
      verb: 'updated',
    };
    this.eventEmitter?.emit('work-item.updated', payload);

    return { subscribers: updated };
  }
}
