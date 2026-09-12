import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { ProjectMemberRole, EntityType } from '@prisma/client';
import { DomainActivityEvent } from '@/modules/activity/events/activity.events';
import { MemberRepository } from './member.repository';
import {
  AddProjectMemberDto,
  BulkAddProjectMembersDto,
  UpdateProjectMemberDto,
  QueryProjectMembersDto,
} from './dto/member.dto';
import {
  ProjectMemberListResponse,
  BulkAddProjectMembersResult,
  ProjectMemberWithUser,
} from './types/member.types';

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

    const role = dto.role || ProjectMemberRole.contributor;

    // Prevent assigning owner role via invitation
    if (role === ProjectMemberRole.owner) {
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
        workspaceId: project.workspaceId,
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
    if (targetRole === ProjectMemberRole.owner) {
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
          workspaceId: project.workspaceId,
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
   * 1. Last Owner Protection: cannot demote/remove the only owner of the project.
   * 2. Lead consistency: if demoted to non-execution role (viewer/commenter), project lead is cleared.
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
    if (dto.role === ProjectMemberRole.owner) {
      throw new ForbiddenException(
        'Cannot assign owner role. Use transfer ownership instead.',
      );
    }

    // Last Owner Protection: cannot demote the only owner
    if (existing.role === ProjectMemberRole.owner) {
      const ownerCount = await this.memberRepo.countAdmins(projectId); // reuse countAdmins → counts owners
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot demote the only owner of the project. Transfer ownership to another member first.',
        );
      }
    }

    // If member was lead and demoted to read-only or commenter, clear lead
    if (
      project.leadId === targetUserId &&
      (dto.role === ProjectMemberRole.commenter ||
        dto.role === ProjectMemberRole.viewer)
    ) {
      await this.memberRepo.clearProjectLeadIfMatches(projectId, targetUserId);
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
        workspaceId: project.workspaceId,
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
   * 2. Clears Project Lead if removed user is lead.
   * 3. Unassigns all active tasks currently assigned to this user in this project.
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

    // Last Owner Protection: cannot remove the only owner
    if (existing.role === ProjectMemberRole.owner) {
      const ownerCount = await this.memberRepo.countAdmins(projectId);
      if (ownerCount <= 1) {
        throw new ForbiddenException(
          'Cannot remove the only owner of the project. Transfer ownership to another member first.',
        );
      }
    }

    // Clear Project Lead if user was lead
    if (project.leadId === targetUserId) {
      await this.memberRepo.clearProjectLeadIfMatches(projectId, targetUserId);
    }

    // Unassign tasks assigned to this member in this project to prevent ghost assignees
    await this.memberRepo.unassignMemberTasks(projectId, targetUserId);

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
        workspaceId: project.workspaceId,
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
        this.cache.del(`flux:iam:proj_role:${projectId}:${userId}`),
        this.cache.del(`flux:project:${projectId}`),
        this.cache.del(`flux:wi:tasks:${projectId}`),
      ]);
    } catch {
      // Best effort cache invalidation
    }
  }
}
