import { MemberService } from '@/modules/project/member/member.service';
import { MemberRepository } from '@/modules/project/member/member.repository';
import { ProjectMemberWithUser } from '@/modules/project/core/types/project.type';
import { ProjectMemberRole } from '@prisma/client';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

describe('Project Member Module', () => {
  let memberService: MemberService;
  let mockMemberRepo: jest.Mocked<Partial<MemberRepository>>;
  let mockEventEmitter: { emit: jest.Mock };
  let mockCache: { del: jest.Mock };

  const projectId = '00000000-0000-0000-0000-000000000001';
  const workspaceId = '00000000-0000-0000-0000-000000000002';
  const adminUserId = '00000000-0000-0000-0000-000000000011';
  const contributorUserId = '00000000-0000-0000-0000-000000000012';
  const guestUserId = '00000000-0000-0000-0000-000000000013';
  const nonWsUserId = '00000000-0000-0000-0000-000000000014';

  const createMockMember = (
    userId: string,
    role: ProjectMemberRole,
  ): ProjectMemberWithUser => ({
    id: `pm-${userId}`,
    projectId,
    userId,
    role,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    user: {
      id: userId,
      name: `User ${userId.slice(-2)}`,
      email: `user${userId.slice(-2)}@example.com`,
      avatar: null,
    },
  });

  beforeEach(() => {
    mockMemberRepo = {
      findProject: jest.fn().mockResolvedValue({
        id: projectId,
        workspaceId,
      }),
      findMember: jest.fn().mockImplementation((pId, uId) => {
        if (pId !== projectId) return Promise.resolve(null);
        if (uId === adminUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.owner),
          );
        }
        if (uId === contributorUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.contributor),
          );
        }
        return Promise.resolve(null);
      }),
      findMembers: jest
        .fn()
        .mockResolvedValue([
          createMockMember(adminUserId, ProjectMemberRole.owner),
          createMockMember(contributorUserId, ProjectMemberRole.contributor),
        ]),
      countMembers: jest.fn().mockResolvedValue(2),
      createMember: jest.fn().mockImplementation((pId, uId, role) => {
        return Promise.resolve(createMockMember(uId, role));
      }),
      updateMemberRole: jest.fn().mockImplementation((pId, uId, role) => {
        return Promise.resolve(createMockMember(uId, role));
      }),
      deleteMember: jest.fn().mockResolvedValue(undefined),
      countOwners: jest.fn().mockResolvedValue(2),
      findUser: jest.fn().mockImplementation((uId) => {
        if (uId === nonWsUserId) return Promise.resolve(null);
        return Promise.resolve({
          id: uId,
          name: `User ${uId.slice(-2)}`,
          email: `user${uId.slice(-2)}@example.com`,
          avatar: null,
        });
      }),
      unassignMemberTasks: jest.fn().mockResolvedValue(3),
    };

    mockEventEmitter = { emit: jest.fn() };
    mockCache = { del: jest.fn().mockResolvedValue(true) };

    memberService = new MemberService(
      mockMemberRepo as unknown as MemberRepository,
      mockEventEmitter as any,
      mockCache as any,
    );
  });

  describe('getMembers & getMember', () => {
    it('returns list of members and total count with pagination metadata', async () => {
      const result = await memberService.getMembers(projectId, {
        page: 1,
        limit: 10,
      });
      expect(result.members).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('throws NotFoundException if project is not found', async () => {
      mockMemberRepo.findProject = jest.fn().mockResolvedValue(null);
      await expect(
        memberService.getMembers('non-existent-proj'),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns a single member by user ID', async () => {
      const result = await memberService.getMember(projectId, adminUserId);
      expect(result.member.userId).toBe(adminUserId);
      expect(result.member.role).toBe(ProjectMemberRole.owner);
    });

    it('throws NotFoundException if single member does not exist in project', async () => {
      await expect(
        memberService.getMember(projectId, 'unknown-user'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addMember', () => {
    it('successfully adds a user with default contributor role', async () => {
      const newUserId = '00000000-0000-0000-0000-000000000099';

      const result = await memberService.addMember(projectId, {
        userId: newUserId,
      });

      expect(result.member.role).toBe(ProjectMemberRole.contributor);
      expect(mockMemberRepo.createMember).toHaveBeenCalledWith(
        projectId,
        newUserId,
        ProjectMemberRole.contributor,
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.member_added',
        expect.objectContaining({
          entityType: 'project',
          verb: 'member_added',
          newValue: newUserId,
        }),
      );
    });

    it('rejects adding a member if they are already in the project', async () => {
      await expect(
        memberService.addMember(projectId, { userId: adminUserId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects adding a member if user does not exist in the system', async () => {
      await expect(
        memberService.addMember(projectId, { userId: nonWsUserId }),
      ).rejects.toThrow(NotFoundException);
    });

    it('blocks inviting a user directly as owner', async () => {
      await expect(
        memberService.addMember(projectId, {
          userId: guestUserId,
          role: ProjectMemberRole.owner,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('bulkAddMembers', () => {
    it('bulk adds eligible users while skipping existing or non-existent users', async () => {
      const user1 = '00000000-0000-0000-0000-000000000021';
      const nonExistent = nonWsUserId;

      const result = await memberService.bulkAddMembers(projectId, {
        userIds: [adminUserId, user1, nonExistent],
        role: ProjectMemberRole.contributor,
      });

      // adminUserId is already member -> skipped
      // user1 is valid user -> added
      // nonExistent does not exist -> skipped
      expect(result.addedCount).toBe(1);
      expect(result.skippedCount).toBe(2);
      expect(result.members[0].userId).toBe(user1);
    });
  });

  describe('updateMemberRole', () => {
    it('successfully updates a member role', async () => {
      const result = await memberService.updateMemberRole(
        projectId,
        contributorUserId,
        {
          role: ProjectMemberRole.commenter,
        },
      );
      expect(result.member.role).toBe(ProjectMemberRole.commenter);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.member_updated',
        expect.objectContaining({
          verb: 'member_updated',
          newValue: ProjectMemberRole.commenter,
        }),
      );
    });

    it('enforces Single Admin Invariant: blocks demoting the only admin', async () => {
      mockMemberRepo.countOwners = jest.fn().mockResolvedValue(1);

      await expect(
        memberService.updateMemberRole(projectId, adminUserId, {
          role: ProjectMemberRole.contributor,
        }),
      ).rejects.toThrow(/Cannot demote the only (admin|owner) of the project/);
    });
  });

  describe('removeMember & leaveProject', () => {
    it('successfully removes a member and unassigns their active tasks', async () => {
      const result = await memberService.removeMember(
        projectId,
        contributorUserId,
      );

      expect(result.message).toBe('Project member removed successfully');
      expect(mockMemberRepo.unassignMemberTasks).toHaveBeenCalledWith(
        projectId,
        contributorUserId,
      );
      expect(mockMemberRepo.deleteMember).toHaveBeenCalledWith(
        projectId,
        contributorUserId,
      );
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'project.member_removed',
        expect.objectContaining({
          verb: 'member_removed',
          oldValue: contributorUserId,
        }),
      );
    });

    it('enforces Single Admin Invariant: blocks removing the only admin', async () => {
      mockMemberRepo.countOwners = jest.fn().mockResolvedValue(1);

      await expect(
        memberService.removeMember(projectId, adminUserId),
      ).rejects.toThrow(/Cannot remove the only (admin|owner) of the project/);
    });

    it('leaveProject delegates cleanly to removeMember', async () => {
      const result = await memberService.leaveProject(
        projectId,
        contributorUserId,
      );
      expect(result.message).toBe('Project member removed successfully');
      expect(mockMemberRepo.deleteMember).toHaveBeenCalledWith(
        projectId,
        contributorUserId,
      );
    });
  });
});
