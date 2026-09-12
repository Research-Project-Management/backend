import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskCommentService } from '@/modules/work-item/comment/comment.service';
import { TaskCommentRepository } from '@/modules/work-item/comment/comment.repository';
import { PrismaService } from '@/core/database/prisma.service';

describe('Comment Module (Task Discussions & Threading)', () => {
  let service: TaskCommentService;
  let mockCommentRepo: {
    findAuthorById: jest.Mock;
    findTaskComments: jest.Mock;
    findTaskCommentById: jest.Mock;
    findTaskCommentWithProject: jest.Mock;
    findWorkspaceMemberRole: jest.Mock;
    findProjectMemberRole: jest.Mock;
    createTaskComment: jest.Mock;
    updateTaskComment: jest.Mock;
    deleteTaskComment: jest.Mock;
  };

  const mockTaskId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockOtherUserId = '33333333-3333-3333-3333-333333333333';
  const mockCommentId = '44444444-4444-4444-4444-444444444444';
  const mockWorkspaceId = '55555555-5555-5555-5555-555555555555';
  const mockProjectId = '66666666-6666-6666-6666-666666666666';

  beforeEach(() => {
    mockCommentRepo = {
      findAuthorById: jest.fn().mockResolvedValue({
        id: mockUserId,
        name: 'Marie Curie',
        avatar: null,
        email: 'marie@flux.dev',
      }),
      findTaskComments: jest.fn().mockResolvedValue([]),
      findTaskCommentById: jest.fn(),
      findTaskCommentWithProject: jest.fn(),
      findWorkspaceMemberRole: jest.fn().mockResolvedValue(null),
      findProjectMemberRole: jest.fn().mockResolvedValue(null),
      createTaskComment: jest.fn(),
      updateTaskComment: jest.fn(),
      deleteTaskComment: jest.fn().mockResolvedValue({} as any),
    };

    service = new TaskCommentService(
      mockCommentRepo as unknown as TaskCommentRepository,
    );
  });

  describe('Comment Retrieval & Creation', () => {
    it('should retrieve all comments for a task', async () => {
      const mockComments = [
        { id: 'c1', taskId: mockTaskId, content: 'First note' },
        { id: 'c2', taskId: mockTaskId, content: 'Second note' },
      ];
      (mockCommentRepo.findTaskComments as jest.Mock).mockResolvedValue(
        mockComments,
      );

      const result = await service.getTaskComments(mockTaskId);

      expect(mockCommentRepo.findTaskComments).toHaveBeenCalledWith(mockTaskId);
      expect(result.comments).toHaveLength(2);
    });

    it('should create a new comment on a work item', async () => {
      const createdComment = {
        id: mockCommentId,
        taskId: mockTaskId,
        authorId: mockUserId,
        content: 'Simulation results look promising.',
      };
      (mockCommentRepo.createTaskComment as jest.Mock).mockResolvedValue(
        createdComment,
      );

      const result = await service.createTaskComment(mockTaskId, mockUserId, {
        content: 'Simulation results look promising.',
      });

      expect(mockCommentRepo.createTaskComment).toHaveBeenCalledWith({
        taskId: mockTaskId,
        authorId: mockUserId,
        content: 'Simulation results look promising.',
      });
      expect(result.comment.id).toBe(mockCommentId);
    });
  });

  describe('Comment Authorization & Updates', () => {
    const existingComment = {
      id: mockCommentId,
      authorId: mockUserId,
      task: {
        projectId: mockProjectId,
        project: { workspaceId: mockWorkspaceId },
      },
    };

    it('should allow author to update their own comment', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue(existingComment as any);
      (mockCommentRepo.updateTaskComment as jest.Mock).mockResolvedValue({
        ...existingComment,
        content: 'Updated content',
        isEdited: true,
      });

      const result = await service.updateTaskComment(
        mockCommentId,
        mockUserId,
        {
          content: 'Updated content',
        },
      );

      expect(mockCommentRepo.updateTaskComment).toHaveBeenCalledWith(
        mockCommentId,
        {
          content: 'Updated content',
          isEdited: true,
        },
      );
      expect(result.comment.content).toBe('Updated content');
    });

    it('should allow workspace admin to update a comment even if not author', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue(existingComment as any);
      mockCommentRepo.findWorkspaceMemberRole.mockResolvedValue('admin');
      (mockCommentRepo.updateTaskComment as jest.Mock).mockResolvedValue({
        ...existingComment,
        content: 'Moderated by admin',
        isEdited: true,
      });

      const result = await service.updateTaskComment(
        mockCommentId,
        mockOtherUserId,
        {
          content: 'Moderated by admin',
        },
      );

      expect(result.comment.content).toBe('Moderated by admin');
    });

    it('should allow project admin to update a comment even if not author', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue(existingComment as any);
      mockCommentRepo.findProjectMemberRole.mockResolvedValue('admin');
      (mockCommentRepo.updateTaskComment as jest.Mock).mockResolvedValue({
        ...existingComment,
        content: 'Moderated by project admin',
        isEdited: true,
      });

      const result = await service.updateTaskComment(
        mockCommentId,
        mockOtherUserId,
        {
          content: 'Moderated by project admin',
        },
      );

      expect(result.comment.content).toBe('Moderated by project admin');
    });

    it('should throw ForbiddenException if user is not author and lacks admin role', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue(existingComment as any);
      mockCommentRepo.findWorkspaceMemberRole.mockResolvedValue('member');
      mockCommentRepo.findProjectMemberRole.mockResolvedValue('contributor');

      await expect(
        service.updateTaskComment(mockCommentId, mockOtherUserId, {
          content: 'Malicious edit',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if comment does not exist', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue(null);

      await expect(
        service.updateTaskComment('non-existent', mockUserId, {
          content: 'Test',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Comment Deletion', () => {
    it('should allow author to delete comment', async () => {
      mockCommentRepo.findTaskCommentWithProject.mockResolvedValue({
        id: mockCommentId,
        authorId: mockUserId,
        task: {
          projectId: mockProjectId,
          project: { workspaceId: mockWorkspaceId },
        },
      } as any);

      const result = await service.deleteTaskComment(mockCommentId, mockUserId);

      expect(mockCommentRepo.deleteTaskComment).toHaveBeenCalledWith(
        mockCommentId,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('Threading & Replies', () => {
    it('should append a threaded reply to a comment', async () => {
      (mockCommentRepo.findTaskCommentById as jest.Mock).mockResolvedValue({
        id: mockCommentId,
        replies: [],
      });
      (mockCommentRepo.updateTaskComment as jest.Mock).mockImplementation(
        (_id, data) => ({
          id: mockCommentId,
          replies: data.replies,
        }),
      );

      const result = await service.addTaskReply(mockCommentId, mockUserId, {
        content: 'I agree with this hypothesis.',
      });

      expect(mockCommentRepo.updateTaskComment).toHaveBeenCalledWith(
        mockCommentId,
        expect.objectContaining({
          replies: [
            expect.objectContaining({
              content: 'I agree with this hypothesis.',
              author: expect.objectContaining({ name: 'Marie Curie' }),
            }),
          ],
        }),
      );
      expect(result.comment).toBeDefined();
    });

    it('should throw NotFoundException if replying to non-existent comment', async () => {
      (mockCommentRepo.findTaskCommentById as jest.Mock).mockResolvedValue(
        null,
      );

      await expect(
        service.addTaskReply('non-existent', mockUserId, { content: 'Reply' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Emoji Reactions', () => {
    it('should add reaction if user has not reacted yet', async () => {
      (mockCommentRepo.findTaskCommentById as jest.Mock).mockResolvedValue({
        id: mockCommentId,
        reactions: {},
      });
      (mockCommentRepo.updateTaskComment as jest.Mock).mockImplementation(
        (_id, data) => ({
          id: mockCommentId,
          reactions: data.reactions,
        }),
      );

      const result = await service.reactToTaskComment(
        mockCommentId,
        mockUserId,
        {
          emoji: '👍',
        },
      );

      expect(mockCommentRepo.updateTaskComment).toHaveBeenCalledWith(
        mockCommentId,
        {
          reactions: { '👍': [mockUserId] },
        },
      );
      expect(result.comment).toBeDefined();
    });

    it('should toggle off (remove) reaction if user already reacted with the same emoji', async () => {
      (mockCommentRepo.findTaskCommentById as jest.Mock).mockResolvedValue({
        id: mockCommentId,
        reactions: { '👍': [mockUserId, 'someone-else'] },
      });
      (mockCommentRepo.updateTaskComment as jest.Mock).mockImplementation(
        (_id, data) => ({
          id: mockCommentId,
          reactions: data.reactions,
        }),
      );

      await service.reactToTaskComment(mockCommentId, mockUserId, {
        emoji: '👍',
      });

      expect(mockCommentRepo.updateTaskComment).toHaveBeenCalledWith(
        mockCommentId,
        {
          reactions: { '👍': ['someone-else'] },
        },
      );
    });
  });
});
