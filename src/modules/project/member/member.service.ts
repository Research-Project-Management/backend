import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis.service';
import { ProjectMemberRole, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { MemberRepository } from './member.repository';
import { AddProjectMemberDto, BulkAddProjectMembersDto } from './dto/add.dto';
import { UpdateProjectMemberDto } from './dto/update.dto';
import { QueryProjectMembersDto } from './dto/query.dto';
import {
  ProjectMemberListResponse,
  BulkAddProjectMembersResult,
  ProjectMemberWithUser,
} from './types/member.type';
import {
  isOwner,
  canDemoteOrRemoveOwner,
} from './utils/role.util';
import { CACHE_KEYS } from '../core/constants/cache.constant';
import { IAM_REDIS_KEYS } from '@/modules/iam/core/constants/redis.constant';

@Injectable()
export class MemberService {
  constructor(
    private readonly memberRepo: MemberRepository,
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly cache?: RedisCacheService,
  ) {}

  /**
   * List all project members with optional role and search filters.
   */
  async getMembers(
    projectId: string,
    query?: QueryProjectMembersDto,
  ): Promise<ProjectMemberListResponse> {
    const project = await this.memberRepo.findProject(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const page = query?.page && query.page > 0 ? query.page : 1;
    const limit = query?.limit && query.limit > 0 ? query.limit : 50;
    const skip = (page - 1) * limit;

    const [members, total] = await Promise.all([
      this.memberRepo.findMembers(projectId, {
        role: query?.role,
        search: query?.search?.trim(),
        take: limit,
        skip,
      }),
      this.memberRepo.countMembers(projectId, {
        role: query?.role,
        search: query?.search?.trim(),
      }),
    ]);

    return {
      members,
      total,
      page,
      limit,
    };
  }

  /**
   * Get a single project member by their User ID.
   */
  async getMember(
    projectId: string,
    userId: string,
  ): Promise<{ member: ProjectMemberWithUser }> {
    const member = await this.memberRepo.findMember(projectId, userId);
    if (!member) {
      throw new NotFoundException('Project member not found');
    }
    return { member };
  }

  /**
   * Add a single member to a project.
   * Enforces:
   * 1. Cannot add duplicate members.
   * 2. Cannot invite a user as owner (ownership is only via project creation or transfer).
   * 3. The invited user must exist in the system.
   */
  async addMember(
    projectId: string,
    dto: AddProjectMemberDto,
    actorId?: string,
  ): Promise<{ message: string; member: ProjectMemberWithUser }> {
    const project = await this.memberRepo.findProject(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const existing = await this.memberRepo.findMember(projectId, dto.userId);
    if (existing) {
      throw new BadRequestException('User is already a member of this project');
    }

    const targetUser = await this.memberRepo.findUser(dto.userId);
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }

    const role = dto.role || ProjectMemberRole.contributor;

    // Prevent assigning owner role via invitation
    if (isOwner(role)) {
      throw new ForbiddenException(
        'Cannot invite a user as project owner. Use transfer ownership instead.',
      );
    }

    const member = await this.memberRepo.createMember(
      projectId,
      dto.userId,
      role,
    );

    await this.invalidateMemberCaches(projectId, dto.userId);

    this.eventEmitter?.emit(
      'project.member_added',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'member_added',
        field: 'members',
        newValue: dto.userId,
        actorId: actorId || '',
        projectId,
      }),
    );

    return {
      message: 'Project member added successfully',
      member,
    };
  }

  /**
   * Bulk-add multiple members to a project.
   */
  async bulkAddMembers(
    projectId: string,
    dto: BulkAddProjectMembersDto,
    actorId?: string,
  ): Promise<BulkAddProjectMembersResult> {
    const project = await this.memberRepo.findProject(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const targetRole = dto.role || ProjectMemberRole.contributor;

    // Block bulk-assigning owner role
    if (isOwner(targetRole)) {
      throw new ForbiddenException(
        'Cannot bulk-assign owner role. Use transfer ownership instead.',
      );
    }

    const addedMembers: ProjectMemberWithUser[] = [];
    let skippedCount = 0;

    for (const userId of dto.userIds) {
      const existing = await this.memberRepo.findMember(projectId, userId);
      if (existing) {
        skippedCount++;
        continue;
      }

      const targetUser = await this.memberRepo.findUser(userId);
      if (!targetUser) {
        skippedCount++;
        continue;
      }

      const member = await this.memberRepo.createMember(
        projectId,
        userId,
        targetRole,
      );
      addedMembers.push(member);
      await this.invalidateMemberCaches(projectId, userId);
    }

    if (addedMembers.length > 0) {
      this.eventEmitter?.emit(
        'project.member_added',
        new DomainActivityEvent({
          entityType: 'project' as unknown as EntityType,
          entityId: projectId,
          verb: 'members_bulk_added',
          actorId: actorId || '',
          projectId,
        }),
      );
    }

    return {
      addedCount: addedMembers.length,
      skippedCount,
      members: addedMembers,
    };
  }

  /**
   * Update a project member's role.
   * Enforces:
   * 1. Single-Owner Protection: cannot demote the only owner of the project.
   */
  async updateMemberRole(
    projectId: string,
    targetUserId: string,
    dto: UpdateProjectMemberDto,
    actorId?: string,
  ): Promise<{ message: string; member: ProjectMemberWithUser }> {
    const existing = await this.memberRepo.findMember(projectId, targetUserId);
    if (!existing) {
      throw new NotFoundException('Project member not found');
    }

    const project = await this.memberRepo.findProject(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Cannot assign owner role via update — use transfer ownership
    if (isOwner(dto.role)) {
      throw new ForbiddenException(
        'Cannot assign owner role. Use transfer ownership instead.',
      );
    }

    // Single-Owner Protection: cannot demote the only owner
    if (isOwner(existing.role)) {
      const ownerCount = await this.memberRepo.countOwners(projectId);
      if (!canDemoteOrRemoveOwner(ownerCount)) {
        throw new ForbiddenException(
          'Cannot demote the only owner of the project. Elevate another member first.',
        );
      }
    }

    const member = await this.memberRepo.updateMemberRole(
      projectId,
      targetUserId,
      dto.role,
    );

    await this.invalidateMemberCaches(projectId, targetUserId);

    this.eventEmitter?.emit(
      'project.member_updated',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'member_updated',
        field: 'role',
        oldValue: existing.role,
        newValue: dto.role,
        actorId: actorId || '',
        projectId,
      }),
    );

    return {
      message: 'Project member role updated successfully',
      member,
    };
  }

  /**
   * Remove a member from a project.
   * Enforces:
   * 1. Last Owner Protection: cannot remove the only owner.
   * 2. Unassigns all active work items currently assigned to this user in this project.
   */
  async removeMember(
    projectId: string,
    targetUserId: string,
    actorId?: string,
  ): Promise<{ message: string }> {
    const existing = await this.memberRepo.findMember(projectId, targetUserId);
    if (!existing) {
      throw new NotFoundException('Project member not found');
    }

    const project = await this.memberRepo.findProject(projectId);
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // Single-Owner Invariant: cannot remove the only owner
    if (isOwner(existing.role)) {
      const ownerCount = await this.memberRepo.countOwners(projectId);
      if (!canDemoteOrRemoveOwner(ownerCount)) {
        throw new ForbiddenException(
          'Cannot remove the only owner of the project. Transfer ownership to another member first.',
        );
      }
    }

    // Unassign work items assigned to this member in this project to prevent ghost assignees
    await this.memberRepo.unassignMemberWorkItems(projectId, targetUserId);

    // Delete membership
    await this.memberRepo.deleteMember(projectId, targetUserId);

    await this.invalidateMemberCaches(projectId, targetUserId);

    this.eventEmitter?.emit(
      'project.member_removed',
      new DomainActivityEvent({
        entityType: 'project' as unknown as EntityType,
        entityId: projectId,
        verb: 'member_removed',
        field: 'members',
        oldValue: targetUserId,
        actorId: actorId || '',
        projectId,
      }),
    );

    return { message: 'Project member removed successfully' };
  }

  /**
   * Self-leave project action by caller.
   */
  async leaveProject(
    projectId: string,
    userId: string,
  ): Promise<{ message: string }> {
    return this.removeMember(projectId, userId, userId);
  }

  private async invalidateMemberCaches(
    projectId: string,
    userId: string,
  ): Promise<void> {
    if (!this.cache) return;
    try {
      await Promise.all([
        this.cache.del(IAM_REDIS_KEYS.role(projectId, userId)),
        this.cache.del(IAM_REDIS_KEYS.permissions(projectId, userId)),
        this.cache.del(CACHE_KEYS.detail(projectId)),
        this.cache.del(CACHE_KEYS.overview(projectId)),
        this.cache.del(CACHE_KEYS.userProjects(userId)),
        this.cache.del(`flux:wi:work-items:${projectId}`),
      ]);
    } catch {
      // Best effort cache invalidation
    }
  }
}
