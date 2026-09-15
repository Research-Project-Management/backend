import { Test, TestingModule } from '@nestjs/testing';
import { NodeService } from '@/modules/document/node/node.service';
import { NodeRepository } from '@/modules/document/node/node.repository';
import { RedisCacheService } from '@/core/cache/redis.service';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PageStatus } from '@prisma/client';

describe('Document NodeService (Tree & Node Hierarchy Operations)', () => {
  let service: NodeService;
  let repo: jest.Mocked<NodeRepository>;
  let cache: jest.Mocked<RedisCacheService>;

  const mockProjectId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockRootNodeId = '33333333-3333-3333-3333-333333333333';
  const mockChildNodeId = '44444444-4444-4444-4444-444444444444';
  const mockGrandchildId = '55555555-5555-5555-5555-555555555555';

  const mockFlatNodes: any[] = [
    {
      id: mockRootNodeId,
      title: 'main.tex',
      slug: 'main-tex',
      icon: 'file-text',
      rank: 0,
      status: PageStatus.draft,
      isLocked: false,
      parentPageId: null,
      mainFileId: null,
      projectId: mockProjectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: mockChildNodeId,
      title: 'chapters/intro.tex',
      slug: 'chapters-intro-tex',
      icon: 'file',
      rank: 1,
      status: PageStatus.draft,
      isLocked: false,
      parentPageId: mockRootNodeId,
      mainFileId: null,
      projectId: mockProjectId,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  beforeEach(async () => {
    const mockRepo = {
      resolveProjectId: jest.fn().mockResolvedValue(mockProjectId),
      findProjectNodes: jest.fn().mockResolvedValue(mockFlatNodes),
      findNodeById: jest.fn(),
      findNodeAncestors: jest.fn(),
      findDirectChildren: jest.fn(),
      updateParentAndRank: jest.fn(),
      setMainFile: jest.fn(),
      createNode: jest.fn(),
    };

    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
      wrap: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeService,
        { provide: NodeRepository, useValue: mockRepo },
        { provide: RedisCacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<NodeService>(NodeService);
    repo = module.get(NodeRepository);
    cache = module.get(RedisCacheService);
  });

  describe('getProjectTree', () => {
    it('should build hierarchical nested tree from flat project nodes', async () => {
      const result = await service.getProjectTree(mockProjectId);

      expect(repo.resolveProjectId).toHaveBeenCalledWith(mockProjectId);
      expect(repo.findProjectNodes).toHaveBeenCalledWith(mockProjectId);
      expect(result.nodes).toHaveLength(2);
      expect(result.tree).toHaveLength(1); // root node
      expect(result.tree[0].id).toBe(mockRootNodeId);
      expect(result.tree[0].children).toHaveLength(1);
      expect(result.tree[0].children![0].id).toBe(mockChildNodeId);
    });

    it('should return cached tree if present in Redis', async () => {
      const cachedData = { nodes: mockFlatNodes, tree: [] };
      cache.get.mockResolvedValueOnce(cachedData);

      const result = await service.getProjectTree(mockProjectId);

      expect(result).toBe(cachedData);
      expect(repo.findProjectNodes).not.toHaveBeenCalled();
    });
  });

  describe('getAncestors', () => {
    it('should retrieve recursive breadcrumbs ancestor chain', async () => {
      const mockAncestors = [
        { id: mockRootNodeId, parentPageId: null, title: 'Root', depth: 1 },
        {
          id: mockChildNodeId,
          parentPageId: mockRootNodeId,
          title: 'Child',
          depth: 2,
        },
      ];
      repo.findNodeAncestors.mockResolvedValueOnce(mockAncestors);

      const result = await service.getAncestors(mockChildNodeId);

      expect(repo.findNodeAncestors).toHaveBeenCalledWith(mockChildNodeId);
      expect(result.ancestors).toEqual(mockAncestors);
    });
  });

  describe('moveNode', () => {
    it('should prevent node from becoming its own parent', async () => {
      repo.findNodeById.mockResolvedValueOnce({
        id: mockRootNodeId,
        projectId: mockProjectId,
        rank: 0,
      } as any);

      await expect(
        service.moveNode(mockRootNodeId, { targetParentId: mockRootNodeId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject move if circular hierarchy loop is detected', async () => {
      repo.findNodeById
        .mockResolvedValueOnce({
          id: mockRootNodeId,
          projectId: mockProjectId,
          rank: 0,
        } as any)
        .mockResolvedValueOnce({
          id: mockGrandchildId,
          projectId: mockProjectId,
          rank: 0,
        } as any);

      // Ancestors of grandchild contain the root node
      repo.findNodeAncestors.mockResolvedValueOnce([
        { id: mockRootNodeId, parentPageId: null, title: 'Root', depth: 1 },
        {
          id: mockChildNodeId,
          parentPageId: mockRootNodeId,
          title: 'Child',
          depth: 2,
        },
      ]);

      await expect(
        service.moveNode(mockRootNodeId, { targetParentId: mockGrandchildId }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should successfully reparent and update rank for a node', async () => {
      repo.findNodeById
        .mockResolvedValueOnce({
          id: mockChildNodeId,
          projectId: mockProjectId,
          rank: 1,
        } as any)
        .mockResolvedValueOnce({
          id: mockRootNodeId,
          projectId: mockProjectId,
          rank: 0,
        } as any);

      repo.findNodeAncestors.mockResolvedValueOnce([]);
      repo.updateParentAndRank.mockResolvedValueOnce({
        id: mockChildNodeId,
        parentPageId: mockRootNodeId,
        rank: 5,
      } as any);

      const res = await service.moveNode(mockChildNodeId, {
        targetParentId: mockRootNodeId,
        rank: 5,
      });

      expect(repo.updateParentAndRank).toHaveBeenCalledWith(
        mockChildNodeId,
        mockRootNodeId,
        5,
      );
      expect(cache.del).toHaveBeenCalled();
      expect(res.node.rank).toBe(5);
    });
  });

  describe('setMainFile', () => {
    it('should designate a file node as main compilation entrypoint', async () => {
      repo.findNodeById
        .mockResolvedValueOnce({
          id: mockRootNodeId,
          projectId: mockProjectId,
        } as any)
        .mockResolvedValueOnce({
          id: mockChildNodeId,
          projectId: mockProjectId,
        } as any);

      repo.setMainFile.mockResolvedValueOnce({
        id: mockRootNodeId,
        mainFileId: mockChildNodeId,
      } as any);

      const res = await service.setMainFile(mockRootNodeId, mockChildNodeId);

      expect(repo.setMainFile).toHaveBeenCalledWith(
        mockRootNodeId,
        mockChildNodeId,
      );
      expect(cache.del).toHaveBeenCalled();
      expect(res.node.mainFileId).toBe(mockChildNodeId);
    });

    it('should reject if designated main file belongs to a different project', async () => {
      repo.findNodeById
        .mockResolvedValueOnce({
          id: mockRootNodeId,
          projectId: mockProjectId,
        } as any)
        .mockResolvedValueOnce({
          id: 'external-node',
          projectId: 'other-project',
        } as any);

      await expect(
        service.setMainFile(mockRootNodeId, 'external-node'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('createChildNode', () => {
    it('should throw ForbiddenException if parent node is locked', async () => {
      repo.findNodeById.mockResolvedValueOnce({
        id: mockRootNodeId,
        projectId: mockProjectId,
        isLocked: true,
      } as any);

      await expect(
        service.createChildNode(mockRootNodeId, mockUserId, {
          title: 'section2.tex',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should create child node and invalidate tree cache', async () => {
      repo.findNodeById.mockResolvedValueOnce({
        id: mockRootNodeId,
        projectId: mockProjectId,
        isLocked: false,
      } as any);

      repo.createNode.mockResolvedValueOnce({
        id: 'new-node-id',
        title: 'section2.tex',
        parentPageId: mockRootNodeId,
      } as any);

      const res = await service.createChildNode(mockRootNodeId, mockUserId, {
        title: 'section2.tex',
      });

      expect(repo.createNode).toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalled();
      expect(res.node.title).toBe('section2.tex');
    });
  });
});
