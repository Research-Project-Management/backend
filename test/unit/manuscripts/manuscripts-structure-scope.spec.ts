import { NotFoundException } from '@nestjs/common';
import { StructureRepository } from '@/modules/manuscripts/structure/structure.repository';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { DuplicateNodePathError } from '@/modules/manuscripts/structure/domain';

describe('Structure Repository & Service Project Scoping (SEC-02 / US5)', () => {
  let repository: StructureRepository;
  let service: StructureService;
  let mockPrisma: any;

  const projectAId = 'a0000000-0000-4000-8000-000000000001';
  const projectBId = 'b0000000-0000-4000-8000-000000000002';
  const nodeAId = 'n0000000-0000-4000-8000-000000000003';
  const docAId = 'd0000000-0000-4000-8000-000000000004';
  const docBId = 'd0000000-0000-4000-8000-000000000005';
  const fileBId = 'f0000000-0000-4000-8000-000000000006';

  beforeEach(() => {
    mockPrisma = {
      manuscriptNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      manuscriptDoc: {
        findFirst: jest.fn(),
      },
      manuscriptFile: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn((cbOrArray: any) => {
        if (typeof cbOrArray === 'function') {
          return cbOrArray(mockPrisma);
        }
        return Promise.all(cbOrArray);
      }),
    };

    repository = new StructureRepository(mockPrisma);
    service = new StructureService(repository);
  });

  describe('StructureRepository Scope Isolation', () => {
    it('findById should query strictly with projectId', async () => {
      mockPrisma.manuscriptNode.findFirst.mockResolvedValue({
        id: nodeAId,
        projectId: projectAId,
        name: 'main.tex',
        path: '/main.tex',
        type: 'DOC',
        depth: 0,
      });

      const node = await repository.findById(projectAId, nodeAId);
      expect(node).toBeDefined();
      expect(node?.id).toBe(nodeAId);
      expect(mockPrisma.manuscriptNode.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: projectAId,
          OR: [{ id: nodeAId }, { docId: nodeAId }],
        },
      });
    });

    it('findById should return null if node belongs to another project', async () => {
      mockPrisma.manuscriptNode.findFirst.mockResolvedValue(null);

      const node = await repository.findById(projectBId, nodeAId);
      expect(node).toBeNull();
      expect(mockPrisma.manuscriptNode.findFirst).toHaveBeenCalledWith({
        where: {
          projectId: projectBId,
          OR: [{ id: nodeAId }, { docId: nodeAId }],
        },
      });
    });

    it('setRootDoc should fail with NotFoundException if node does not belong to project', async () => {
      mockPrisma.manuscriptNode.findFirst.mockResolvedValue(null);

      await expect(repository.setRootDoc(projectBId, nodeAId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('renameNode should condition update on projectId and throw NotFoundException if count is 0', async () => {
      mockPrisma.manuscriptNode.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.renameNode(projectBId, nodeAId, 'other.tex', '/other.tex'),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.manuscriptNode.updateMany).toHaveBeenCalledWith({
        where: { id: nodeAId, projectId: projectBId },
        data: expect.objectContaining({
          name: 'other.tex',
          path: '/other.tex',
        }),
      });
    });

    it('updateSortOrder should condition update on projectId and throw NotFoundException if count is 0', async () => {
      mockPrisma.manuscriptNode.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.updateSortOrder(projectBId, nodeAId, 5),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.manuscriptNode.updateMany).toHaveBeenCalledWith({
        where: { id: nodeAId, projectId: projectBId },
        data: { sortOrder: 5 },
      });
    });

    it('updateNodeFileId should condition update on projectId and throw NotFoundException if count is 0', async () => {
      mockPrisma.manuscriptNode.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.updateNodeFileId(projectBId, nodeAId, fileBId),
      ).rejects.toThrow(NotFoundException);

      expect(mockPrisma.manuscriptNode.updateMany).toHaveBeenCalledWith({
        where: { id: nodeAId, projectId: projectBId },
        data: expect.objectContaining({ fileId: fileBId }),
      });
    });
  });

  describe('StructureService Foreign Resource Ownership Verification', () => {
    it('createNode should reject creation when referenced docId belongs to a foreign project', async () => {
      // Document lookup in projectA returns null because it belongs to projectB
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue(null);

      await expect(
        service.createNode(projectAId, {
          name: 'stolen.tex',
          type: 'DOC',
          docId: docBId,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('createNode should reject creation when referenced fileId belongs to a foreign project', async () => {
      mockPrisma.manuscriptFile.findFirst.mockResolvedValue(null);

      await expect(
        service.createNode(projectAId, {
          name: 'figure.png',
          type: 'FILE',
          fileId: fileBId,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('createNode should map P2002 Prisma duplicate key conflict to DuplicateNodePathError', async () => {
      mockPrisma.manuscriptDoc.findFirst.mockResolvedValue({
        id: docAId,
        projectId: projectAId,
      });
      mockPrisma.manuscriptNode.create.mockRejectedValue({
        code: 'P2002',
        message: 'Unique constraint failed on the fields: (projectId, path)',
      });

      await expect(
        service.createNode(projectAId, {
          name: 'existing.tex',
          type: 'DOC',
          docId: docAId,
        }),
      ).rejects.toThrow(DuplicateNodePathError);
    });
  });
});
