import { AssignmentService } from '@/modules/work-item/assignment/assignment.service';
import {
  AssignmentRepository,
  TaskWithProject,
} from '@/modules/work-item/assignment/assignment.repository';
import {
  ELIGIBLE_ASSIGNEE_ROLES,
  ProjectMemberRole,
} from '@/modules/work-item/assignment/types/assignment.types';
import {
  WorkItem,
  ProjectMember,
} from '@prisma/client';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

describe('Assignment Module & Project Member Governance', () => {
  let assignmentService: AssignmentService;
  let mockAssignmentRepo: jest.Mocked<Partial<AssignmentRepository>>;
  let mockEventEmitter: { emit: jest.Mock };
  let mockCache: { del: jest.Mock };

  const projectId = '00000000-0000-0000-0000-000000000001';
  const taskId = '00000000-0000-0000-0000-000000000003';
  const contributorUserId = '00000000-0000-0000-0000-000000000010';
  const adminUserId = '00000000-0000-0000-0000-000000000011';
  const viewerUserId = '00000000-0000-0000-0000-000000000012';
  const commenterUserId = '00000000-0000-0000-0000-000000000013';

  const baseTask: any = {
    id: taskId,
    identifier: 'FLUX-10',
    sequenceNumber: 10,
    title: 'Test Task',
    content: '',
    columnId: 'todo',
    rank: 0,
    priority: 'medium',
    archivedAt: null,
    labels: [],
    completed: false,
    relations: [],
    startDate: null,
    dueDate: null,
    timeSpent: 0,
    assigneeIds: [],
    updates: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    projectId,
    authorId: adminUserId,
    assigneeId: null,
    cycleId: null,
    parentTaskId: null,
    project: {
      id: projectId,
      settings: {},
    },
  };

  const createMockMember = (
    userId: string,
    role: ProjectMemberRole,
  ): ProjectMember => ({
    id: `pm-${userId}`,
    projectId,
    userId,
    role,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(() => {
    mockAssignmentRepo = {
      findTask: jest.fn(),
      findTaskWithProject: jest.fn().mockResolvedValue({ ...baseTask }),
      findProjectMember: jest.fn().mockImplementation((pId, uId) => {
        if (pId !== projectId) return Promise.resolve(null);
        if (uId === contributorUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.contributor),
          );
        }
        if (uId === adminUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.owner),
          );
        }
        if (uId === viewerUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.viewer),
          );
        }
        if (uId === commenterUserId) {
          return Promise.resolve(
            createMockMember(uId, ProjectMemberRole.commenter),
          );
        }
        return Promise.resolve(null);
      }),
      assignTask: jest.fn().mockImplementation((tId, aId) => {
        return Promise.resolve({
          ...baseTask,
          id: tId,
          assigneeId: aId,
        } as WorkItem);
      }),
      bulkAssignTasks: jest.fn().mockResolvedValue(2),
      getProjectSettings: jest.fn().mockResolvedValue({}),
      findEligibleAssignees: jest.fn().mockResolvedValue([]),
    };

    mockEventEmitter = { emit: jest.fn() };
    mockCache = { del: jest.fn().mockResolvedValue(true) };

    assignmentService = new AssignmentService(
      mockAssignmentRepo as unknown as AssignmentRepository,
      mockEventEmitter as any,
      mockCache as any,
    );
  });

  describe('Assignee Eligibility & Rules', () => {
    it('defines ELIGIBLE_ASSIGNEE_ROLES strictly as owner and contributor', () => {
      expect(ELIGIBLE_ASSIGNEE_ROLES).toContain(ProjectMemberRole.owner);
      expect(ELIGIBLE_ASSIGNEE_ROLES).toContain(ProjectMemberRole.contributor);
      expect(ELIGIBLE_ASSIGNEE_ROLES).not.toContain(ProjectMemberRole.viewer);
      expect(ELIGIBLE_ASSIGNEE_ROLES).not.toContain(
        ProjectMemberRole.commenter,
      );
    });

    it('successfully assigns a WorkItem to an active project contributor', () => {
      return assignmentService
        .assignTask(projectId, taskId, contributorUserId, adminUserId)
        .then((result) => {
          expect(result.WorkItem.assigneeId).toBe(contributorUserId);
          expect(result.previousAssigneeId).toBeNull();
          expect(result.newAssigneeId).toBe(contributorUserId);
          expect(mockEventEmitter.emit).toHaveBeenCalledWith(
            'task.assigned',
            expect.objectContaining({
              entityId: taskId,
              verb: 'assigned',
              newValue: contributorUserId,
            }),
          );
        });
    });

    it('successfully assigns a WorkItem to an active project admin', () => {
      return assignmentService
        .assignTask(projectId, taskId, adminUserId, adminUserId)
        .then((result) => {
          expect(result.WorkItem.assigneeId).toBe(adminUserId);
          expect(result.newAssigneeId).toBe(adminUserId);
        });
    });

    it('rejects assigning WorkItem if user is not a member of the project', () => {
      const nonMemberId = '00000000-0000-0000-0000-000000000099';
      return expect(
        assignmentService.assignTask(
          projectId,
          taskId,
          nonMemberId,
          adminUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects assigning WorkItem to a project viewer (read-only)', () => {
      return expect(
        assignmentService.assignTask(
          projectId,
          taskId,
          viewerUserId,
          adminUserId,
        ),
      ).rejects.toThrow(/Cannot assign WorkItem to member with role "viewer"/);
    });

    it('rejects assigning WorkItem to a project commenter (comment-only)', () => {
      return expect(
        assignmentService.assignTask(
          projectId,
          taskId,
          commenterUserId,
          adminUserId,
        ),
      ).rejects.toThrow(/Cannot assign WorkItem to member with role "commenter"/);
    });

    it('throws NotFoundException if WorkItem does not belong to the project', () => {
      const otherProjectId = '00000000-0000-0000-0000-000000000999';
      return expect(
        assignmentService.assignTask(
          otherProjectId,
          taskId,
          contributorUserId,
          adminUserId,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('handles idempotent assignment when target assignee is already current assignee', () => {
      mockAssignmentRepo.findTaskWithProject = jest.fn().mockResolvedValue({
        ...baseTask,
        assigneeId: contributorUserId,
      });

      return assignmentService
        .assignTask(projectId, taskId, contributorUserId, adminUserId)
        .then((result) => {
          expect(result.newAssigneeId).toBe(contributorUserId);
          expect(mockAssignmentRepo.assignTask).not.toHaveBeenCalled();
          expect(mockEventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    it('successfully unassigns a WorkItem and emits task.unassigned event', () => {
      mockAssignmentRepo.findTaskWithProject = jest.fn().mockResolvedValue({
        ...baseTask,
        assigneeId: contributorUserId,
      });

      return assignmentService
        .unassignTask(projectId, taskId, adminUserId)
        .then((result) => {
          expect(result.newAssigneeId).toBeNull();
          expect(result.previousAssigneeId).toBe(contributorUserId);
          expect(mockEventEmitter.emit).toHaveBeenCalledWith(
            'task.unassigned',
            expect.objectContaining({
              entityId: taskId,
              verb: 'unassigned',
              oldValue: contributorUserId,
            }),
          );
        });
    });
  });

  describe('Join & Leave Actions', () => {
    it('joinTask: allows an eligible contributor to self-assign', () => {
      return assignmentService
        .joinTask(projectId, taskId, contributorUserId)
        .then((result) => {
          expect(result.newAssigneeId).toBe(contributorUserId);
        });
    });

    it('joinTask: throws BadRequestException if caller is already assigned', () => {
      mockAssignmentRepo.findTaskWithProject = jest.fn().mockResolvedValue({
        ...baseTask,
        assigneeId: contributorUserId,
      });

      return expect(
        assignmentService.joinTask(projectId, taskId, contributorUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('joinTask: throws ForbiddenException if caller has role viewer', () => {
      return expect(
        assignmentService.joinTask(projectId, taskId, viewerUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('leaveTask: allows the assigned user to unassign themselves', () => {
      mockAssignmentRepo.findTaskWithProject = jest.fn().mockResolvedValue({
        ...baseTask,
        assigneeId: contributorUserId,
      });

      return assignmentService
        .leaveTask(projectId, taskId, contributorUserId)
        .then((result) => {
          expect(result.newAssigneeId).toBeNull();
        });
    });

    it('leaveTask: throws BadRequestException if caller is not the current assignee', () => {
      mockAssignmentRepo.findTaskWithProject = jest.fn().mockResolvedValue({
        ...baseTask,
        assigneeId: contributorUserId,
      });

      return expect(
        assignmentService.leaveTask(projectId, taskId, adminUserId),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Bulk Assignment', () => {
    it('bulk-assigns multiple tasks to an eligible contributor', () => {
      const taskIds = [taskId, '00000000-0000-0000-0000-000000000004'];
      return assignmentService
        .bulkAssign(
          projectId,
          { taskIds, assigneeId: contributorUserId },
          adminUserId,
        )
        .then((result) => {
          expect(result.updatedCount).toBe(2);
          expect(result.assigneeId).toBe(contributorUserId);
          expect(mockAssignmentRepo.bulkAssignTasks).toHaveBeenCalledWith(
            projectId,
            taskIds,
            contributorUserId,
          );
        });
    });

    it('bulk-assign rejects if target user is a viewer', () => {
      const taskIds = [taskId];
      return expect(
        assignmentService.bulkAssign(
          projectId,
          { taskIds, assigneeId: viewerUserId },
          adminUserId,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Default Assignee Resolution', () => {
    it('returns null if project settings does not specify defaultAssigneeId', () => {
      mockAssignmentRepo.getProjectSettings = jest.fn().mockResolvedValue({});
      return assignmentService.resolveDefaultAssignee(projectId).then((id) => {
        expect(id).toBeNull();
      });
    });

    it('returns defaultAssigneeId if member is active contributor or admin', () => {
      mockAssignmentRepo.getProjectSettings = jest.fn().mockResolvedValue({
        defaultAssigneeId: contributorUserId,
      });
      return assignmentService.resolveDefaultAssignee(projectId).then((id) => {
        expect(id).toBe(contributorUserId);
      });
    });

    it('returns null if defaultAssigneeId member has been demoted to viewer', () => {
      mockAssignmentRepo.getProjectSettings = jest.fn().mockResolvedValue({
        defaultAssigneeId: viewerUserId,
      });
      return assignmentService.resolveDefaultAssignee(projectId).then((id) => {
        expect(id).toBeNull();
      });
    });
  });
});
