import { Test, TestingModule } from '@nestjs/testing';
import { CommentService } from '@/modules/document/comment/comment.service';
import { CommentRepository } from '@/modules/document/comment/comment.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { CollaborationGateway } from '@/modules/document/collaboration/collaboration.gateway';
import { CommentStatus } from '@prisma/client';
import {
  NotFoundException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';

describe('CommentService & Discussion Engine (Matt Pocock Deep Module Tests)', () => {
  let service: CommentService;
  let repo: any;
  let prisma: any;
  let collaborationGateway: any;

  const mockPageId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '99999999-9999-9999-9999-999999999999';
  const mockOtherUserId = '88888888-8888-8888-8888-888888888888';
  const mockCommentId = '33333333-3333-3333-3333-333333333333';

  beforeEach(async () => {
    repo = {
      findComments: jest.fn(),
      findCommentById: jest.fn(),
      findAuthorById: jest.fn().mockResolvedValue({
        id: mockUserId,
        name: 'Alice',
        email: 'alice@flux.local',
        avatar: null,
      }),
      createComment: jest.fn(),
      updateComment: jest.fn(),
      deleteComment: jest.fn(),
    };

    prisma = {
      page: {
        findFirst: jest.fn().mockResolvedValue({
          id: mockPageId,
          projectId: 'proj-1',
          authorId: mockUserId,
          parentPageId: null,
        }),
      },
      pageComment: {
        findUnique: jest.fn().mockResolvedValue({
          id: mockCommentId,
          pageId: mockPageId,
          authorId: mockUserId,
          content: 'This needs review',
          replies: '[]',
          page: { projectId: 'proj-1' },
        }),
      },
      projectMember: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'contributor',
        }),
      },
    };

    collaborationGateway = {
      broadcastRoomEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentService,
        { provide: CommentRepository, useValue: repo },
        { provide: PrismaService, useValue: prisma },
        { provide: CollaborationGateway, useValue: collaborationGateway },
      ],
    }).compile();

    service = module.get<CommentService>(CommentService);
  });

  describe('createComment', () => {
    it('should create comment and broadcast comment:created via WebSocket gateway', async () => {
      repo.createComment.mockResolvedValue({
        id: mockCommentId,
        pageId: mockPageId,
        content: 'Please recheck this equation',
        status: CommentStatus.open,
        author: { id: mockUserId, name: 'Alice' },
      });

      const result = await service.createComment(mockPageId, mockUserId, {
        content: 'Please recheck this equation',
        line: 15,
        lineEnd: 15,
      });

      expect(result.comment.id).toBe(mockCommentId);
      expect(repo.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockPageId,
          authorId: mockUserId,
          content: 'Please recheck this equation',
        }),
      );
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'comment:created',
        expect.objectContaining({
          pageId: mockPageId,
          comment: expect.objectContaining({ id: mockCommentId }),
        }),
      );
    });

    it('should reject empty or whitespace-only comments', async () => {
      await expect(
        service.createComment(mockPageId, mockUserId, {
          content: '   \n   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should throw NotFoundException if page does not exist', async () => {
      prisma.page.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createComment(mockPageId, mockUserId, {
          content: 'Some comment',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateComment & resolve', () => {
    it('should allow author to resolve comment and broadcast comment:updated', async () => {
      repo.updateComment.mockResolvedValue({
        id: mockCommentId,
        pageId: mockPageId,
        status: CommentStatus.resolved,
        content: 'This needs review',
      });

      const result = await service.updateComment(mockCommentId, mockUserId, {
        status: CommentStatus.resolved,
      });

      expect(result.comment.status).toBe(CommentStatus.resolved);
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'comment:updated',
        expect.objectContaining({
          pageId: mockPageId,
          comment: expect.objectContaining({ status: CommentStatus.resolved }),
        }),
      );
    });

    it('should prevent unauthorized users from modifying others comments', async () => {
      prisma.pageComment.findUnique.mockResolvedValueOnce({
        id: mockCommentId,
        pageId: mockPageId,
        authorId: mockUserId, // owned by Alice
        page: { projectId: 'proj-1' },
      });
      prisma.projectMember.findUnique.mockResolvedValueOnce({
        role: 'contributor', // not owner
      });

      await expect(
        service.updateComment(mockCommentId, mockOtherUserId, {
          content: 'Hacked comment',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deleteComment', () => {
    it('should delete comment and broadcast comment:deleted', async () => {
      const result = await service.deleteComment(mockCommentId, mockUserId);

      expect(result.success).toBe(true);
      expect(repo.deleteComment).toHaveBeenCalledWith(mockCommentId);
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'comment:deleted',
        expect.objectContaining({
          pageId: mockPageId,
          commentId: mockCommentId,
          deletedBy: mockUserId,
        }),
      );
    });
  });

  describe('replies management', () => {
    it('should add reply to existing comment and broadcast comment:replied', async () => {
      repo.findCommentById.mockResolvedValue({
        id: mockCommentId,
        pageId: mockPageId,
        replies: JSON.stringify([]),
        page: { projectId: 'proj-1' },
      });

      repo.updateComment.mockResolvedValue({
        id: mockCommentId,
        pageId: mockPageId,
      });

      const result = await service.addReply(mockCommentId, mockUserId, {
        content: 'I agree, fixing now.',
      });

      expect(result.comment).toBeDefined();
      expect(repo.updateComment).toHaveBeenCalled();
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'comment:replied',
        expect.objectContaining({
          pageId: mockPageId,
          commentId: mockCommentId,
          reply: expect.objectContaining({ content: 'I agree, fixing now.' }),
        }),
      );
    });

    it('should allow author of reply to delete it and broadcast comment:reply-deleted', async () => {
      const replyId = 'reply-123';
      prisma.pageComment.findUnique.mockResolvedValueOnce({
        id: mockCommentId,
        pageId: mockPageId,
        replies: JSON.stringify([
          {
            id: replyId,
            content: 'I will check',
            author: { id: mockUserId },
            createdAt: new Date().toISOString(),
          },
        ]),
        page: { projectId: 'proj-1' },
      });

      repo.updateComment.mockResolvedValue({
        id: mockCommentId,
        pageId: mockPageId,
      });

      const result = await service.deleteReply(
        mockCommentId,
        replyId,
        mockUserId,
      );

      expect(result.comment).toBeDefined();
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'comment:reply-deleted',
        expect.objectContaining({
          pageId: mockPageId,
          commentId: mockCommentId,
          replyId,
        }),
      );
    });
  });
});
