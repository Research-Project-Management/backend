import { Test, TestingModule } from '@nestjs/testing';
import { CommentService } from '@/modules/document/comment/comment.service';
import { CommentRepository } from '@/modules/document/comment/comment.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { CommentStatus } from '@prisma/client';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

describe('Document CommentService (Server-Authoritative Sanitization & RBAC)', () => {
  let service: CommentService;
  let repo: jest.Mocked<CommentRepository>;
  let prisma: any;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockOtherUserId = '22222222-2222-2222-2222-222222222222';
  const mockPageId = '33333333-3333-3333-3333-333333333333';
  const mockProjectId = '44444444-4444-4444-4444-444444444444';
  const mockCommentId = '55555555-5555-5555-5555-555555555555';

  const mockAuthor = {
    id: mockUserId,
    name: 'Dr. Jane Doe',
    avatar: null,
    email: 'jane@flux.app',
  };

  const mockComment: any = {
    id: mockCommentId,
    pageId: mockPageId,
    authorId: mockUserId,
    content: 'Please clarify this citation.',
    status: CommentStatus.open,
    line: 14,
    lineEnd: 16,
    replies: [],
    author: mockAuthor,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  beforeEach(async () => {
    const mockRepo = {
      findAuthorById: jest.fn().mockResolvedValue(mockAuthor),
      findComments: jest.fn(),
      findCommentById: jest.fn(),
      createComment: jest.fn(),
      updateComment: jest.fn(),
      deleteComment: jest.fn(),
    };

    prisma = {
      page: {
        findUnique: jest.fn().mockResolvedValue({ parentPageId: null }),
        findFirst: jest.fn().mockResolvedValue({
          id: mockPageId,
          parentPageId: null,
          projectId: mockProjectId,
          authorId: mockUserId,
        }),
      },
      pageComment: {
        findUnique: jest.fn(),
      },
      projectMember: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommentService,
        { provide: CommentRepository, useValue: mockRepo },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<CommentService>(CommentService);
    repo = module.get(CommentRepository);
  });

  describe('createComment', () => {
    it('should sanitize XSS script tags and event handlers from content', async () => {
      repo.createComment.mockResolvedValue(mockComment);

      await service.createComment(mockPageId, mockUserId, {
        content:
          'Check this note <script>alert(1)</script><img src=x onerror=alert(2) />',
        line: 10,
      });

      expect(repo.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          pageId: mockPageId,
          authorId: mockUserId,
          content: 'Check this note <img src=x  />',
          line: 10,
        }),
      );
    });

    it('should reject empty or whitespace-only comment content with HTTP 422', async () => {
      await expect(
        service.createComment(mockPageId, mockUserId, {
          content: '   <script>maliciousOnly()</script>   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('updateComment', () => {
    it('should allow comment author to update content with sanitization', async () => {
      prisma.pageComment.findUnique.mockResolvedValue({
        ...mockComment,
        page: { projectId: mockProjectId },
      });
      repo.updateComment.mockResolvedValue({
        ...mockComment,
        content: 'Updated safe content',
      });

      const result = await service.updateComment(mockCommentId, mockUserId, {
        content: 'Updated safe content <script>bad()</script>',
      });

      expect(repo.updateComment).toHaveBeenCalledWith(
        mockCommentId,
        expect.objectContaining({
          content: 'Updated safe content',
          isEdited: true,
        }),
      );
      expect(result.comment.content).toBe('Updated safe content');
    });

    it('should reject update if user is not author or project owner', async () => {
      prisma.pageComment.findUnique.mockResolvedValue({
        ...mockComment,
        page: { projectId: mockProjectId },
      });
      prisma.projectMember.findUnique.mockResolvedValue({
        role: 'contributor',
      });

      await expect(
        service.updateComment(mockCommentId, mockOtherUserId, {
          content: 'Hijacked comment update',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject empty updated content with HTTP 422', async () => {
      prisma.pageComment.findUnique.mockResolvedValue({
        ...mockComment,
        page: { projectId: mockProjectId },
      });

      await expect(
        service.updateComment(mockCommentId, mockUserId, {
          content: '   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('addReply', () => {
    it('should sanitize reply content and append to comment replies JSON', async () => {
      repo.findCommentById.mockResolvedValue(mockComment);
      repo.updateComment.mockResolvedValue({
        ...mockComment,
        replies: [
          { id: 'reply-1', content: 'Safe reply text', author: mockAuthor },
        ],
      });

      const result = await service.addReply(mockCommentId, mockUserId, {
        content: 'Safe reply text <script>stealToken()</script>',
      });

      expect(repo.updateComment).toHaveBeenCalledWith(
        mockCommentId,
        expect.objectContaining({
          replies: expect.arrayContaining([
            expect.objectContaining({
              content: 'Safe reply text',
              author: mockAuthor,
            }),
          ]),
        }),
      );
      expect(result.comment).toBeDefined();
    });

    it('should reject empty reply content with HTTP 422', async () => {
      repo.findCommentById.mockResolvedValue(mockComment);

      await expect(
        service.addReply(mockCommentId, mockUserId, {
          content: '     ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('deleteComment', () => {
    it('should allow project owner to delete any comment', async () => {
      prisma.pageComment.findUnique.mockResolvedValue({
        ...mockComment,
        authorId: mockOtherUserId,
        page: { projectId: mockProjectId },
      });
      prisma.projectMember.findUnique.mockResolvedValue({ role: 'owner' });
      repo.deleteComment.mockResolvedValue(mockComment);

      const result = await service.deleteComment(mockCommentId, mockUserId);
      expect(repo.deleteComment).toHaveBeenCalledWith(mockCommentId);
      expect(result.success).toBe(true);
    });

    it('should reject deletion by non-owner, non-author user', async () => {
      prisma.pageComment.findUnique.mockResolvedValue({
        ...mockComment,
        authorId: mockUserId,
        page: { projectId: mockProjectId },
      });
      prisma.projectMember.findUnique.mockResolvedValue({ role: 'reviewer' });

      await expect(
        service.deleteComment(mockCommentId, mockOtherUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
