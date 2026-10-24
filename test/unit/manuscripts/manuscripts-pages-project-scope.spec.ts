import { NotFoundException } from '@nestjs/common';
import { ManuscriptPageScopeRepository } from '@/modules/manuscripts/docstore/repositories/manuscript-page-scope.repository';

describe('ManuscriptPageScopeRepository & Tenant Isolation', () => {
  let repository: ManuscriptPageScopeRepository;
  let mockPrisma: any;

  const projectAId = 'a0000000-0000-4000-8000-000000000001';
  const projectBId = 'b0000000-0000-4000-8000-000000000002';
  const docAId = 'd0000000-0000-4000-8000-000000000003';
  const threadAId = 't0000000-0000-4000-8000-000000000004';

  beforeEach(() => {
    mockPrisma = {
      manuscriptDoc: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      manuscriptCommentThread: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      manuscriptTrackChange: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
      manuscriptSnapshot: {
        findFirst: jest.fn(),
      },
      manuscriptFile: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    repository = new ManuscriptPageScopeRepository(mockPrisma);
  });

  describe('Document Scoping', () => {
    it('should find document when requested with matching projectId', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: docAId,
        projectId: projectAId,
        path: 'main.tex',
        deleted: false,
      });

      const result = await repository.findDocInProject(projectAId, docAId);
      expect(result).toBeDefined();
      expect(result?.id).toBe(docAId);
      expect(mockPrisma.manuscriptDoc.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: projectAId,
          deleted: false,
          OR: [{ id: docAId }, { node: { id: docAId } }],
        },
      });
    });

    it('should not find document when requested with foreign projectId', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue(null);

      const result = await repository.findDocInProject(projectBId, docAId);
      expect(result).toBeNull();
      expect(mockPrisma.manuscriptDoc.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: projectBId,
          deleted: false,
          OR: [{ id: docAId }, { node: { id: docAId } }],
        },
      });
    });

    it('should throw RESOURCE_NOT_FOUND (no existence oracle) if doc does not belong to project', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue(null);

      await expect(
        repository.getDocInProjectOrThrow(projectBId, docAId),
      ).rejects.toThrow(NotFoundException);

      try {
        await repository.getDocInProjectOrThrow(projectBId, docAId);
      } catch (err: any) {
        expect(err.getResponse()).toMatchObject({
          code: 'RESOURCE_NOT_FOUND',
        });
      }
    });

    it('should scope path searches strictly to target projectId', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: docAId,
        projectId: projectAId,
        path: 'chapters/intro.tex',
      });

      await repository.findDocInProject(projectAId, 'chapters/intro.tex');
      expect(mockPrisma.manuscriptDoc.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: projectAId,
          deleted: false,
          OR: [
            { path: 'chapters/intro.tex' },
            { path: 'chapters/intro.tex' },
            { path: '/chapters/intro.tex' },
          ],
        },
      });
    });
  });

  describe('Comment Thread Scoping', () => {
    it('should delete thread only when projectId matches', async () => {
      mockPrisma.manuscriptCommentThread.deleteMany.mockResolvedValue({
        count: 1,
      });

      const deleted = await repository.deleteThreadInProject(
        projectAId,
        threadAId,
      );
      expect(deleted).toBe(true);
      expect(
        mockPrisma.manuscriptCommentThread.deleteMany,
      ).toHaveBeenCalledWith({
        where: { id: threadAId, projectId: projectAId },
      });
    });

    it('should return false if thread belongs to different project', async () => {
      mockPrisma.manuscriptCommentThread.deleteMany.mockResolvedValue({
        count: 0,
      });

      const deleted = await repository.deleteThreadInProject(
        projectBId,
        threadAId,
      );
      expect(deleted).toBe(false);
      expect(
        mockPrisma.manuscriptCommentThread.deleteMany,
      ).toHaveBeenCalledWith({
        where: { id: threadAId, projectId: projectBId },
      });
    });
  });
});
