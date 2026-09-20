import { Test, TestingModule } from '@nestjs/testing';
import {
  UnprocessableEntityException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { CollectionsService } from '@/modules/library/catalog/application/services/collections.service';
import { CollectionsRepository } from '@/modules/library/catalog/infrastructure/repositories/collections.repository';
import { TreeEngine } from '@/modules/library/catalog/application/engines/tree.engine';
import { PrismaService } from '@/core/database/prisma.service';
import {
  sanitizeCollectionName,
  sanitizeCollectionDescription,
} from '@/modules/library/catalog/application/utils/collections.utils';

describe('Library Collections — Tree Invariants & Sanitization', () => {
  describe('Collection Sanitization Utilities', () => {
    it('should strip script tags and HTML from collection names', () => {
      const dirty = '<script>alert(1)</script><b>Quantum Machine Learning</b>';
      expect(sanitizeCollectionName(dirty)).toBe('Quantum Machine Learning');
    });

    it('should return empty string for empty or whitespace collection names', () => {
      expect(sanitizeCollectionName('')).toBe('');
      expect(sanitizeCollectionName('   ')).toBe('');
      expect(sanitizeCollectionName(null)).toBe('');
      expect(sanitizeCollectionName('<script>alert("xss")</script>')).toBe('');
    });

    it('should truncate collection name to 255 chars', () => {
      const longName = 'C'.repeat(300);
      expect(sanitizeCollectionName(longName).length).toBe(255);
    });

    it('should sanitize collection descriptions and truncate to 1000 chars', () => {
      const dirtyDesc =
        '<script>bad()</script>Notes on transformer architectures';
      expect(sanitizeCollectionDescription(dirtyDesc)).toBe(
        'Notes on transformer architectures',
      );

      const longDesc = 'D'.repeat(1200);
      expect(sanitizeCollectionDescription(longDesc).length).toBe(1000);
    });
  });

  describe('TreeEngine (Cycle Detection & Invariants)', () => {
    const treeEngine = new TreeEngine();

    it('should detect direct cycle where candidate parent equals collection id', () => {
      expect(treeEngine.detectCycle([], 'col-1', 'col-1')).toBe(true);
      expect(() => treeEngine.assertNoCycle([], 'col-1', 'col-1')).toThrow(
        BadRequestException,
      );
    });

    it('should detect 2-level indirect cycle (A -> B -> A)', () => {
      const collections = [
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: 'col-A' },
      ];
      // Setting col-B as parent of col-A would create: col-B -> col-A -> col-B
      expect(treeEngine.detectCycle(collections as any, 'col-A', 'col-B')).toBe(
        true,
      );
      expect(() =>
        treeEngine.assertNoCycle(collections as any, 'col-A', 'col-B'),
      ).toThrow(BadRequestException);
    });

    it('should detect 3-level indirect cycle (A -> B -> C -> A)', () => {
      const collections = [
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: 'col-A' },
        { id: 'col-C', name: 'C', parentId: 'col-B' },
      ];
      // Setting col-C as parent of col-A creates a cycle
      expect(treeEngine.detectCycle(collections as any, 'col-A', 'col-C')).toBe(
        true,
      );
      expect(() =>
        treeEngine.assertNoCycle(collections as any, 'col-A', 'col-C'),
      ).toThrow(BadRequestException);
    });

    it('should allow valid non-cyclical parent assignments', () => {
      const collections = [
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: null },
        { id: 'col-C', name: 'C', parentId: 'col-B' },
      ];
      // Setting col-A as parent of col-C is valid
      expect(treeEngine.detectCycle(collections as any, 'col-C', 'col-A')).toBe(
        false,
      );
      expect(() =>
        treeEngine.assertNoCycle(collections as any, 'col-C', 'col-A'),
      ).not.toThrow();
    });

    it('should build hierarchical tree structure correctly', () => {
      const collections = [
        { id: 'col-1', name: 'Root 1', parentId: null, itemCount: 5 },
        { id: 'col-2', name: 'Sub 1', parentId: 'col-1', itemCount: 2 },
        { id: 'col-3', name: 'Root 2', parentId: null, itemCount: 0 },
      ];
      const tree = treeEngine.buildTree(collections);
      expect(tree).toHaveLength(2);
      expect(tree[0].id).toBe('col-1');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe('col-2');
      expect(tree[1].id).toBe('col-3');
      expect(tree[1].children).toHaveLength(0);
    });
  });

  describe('CollectionsService', () => {
    let service: CollectionsService;
    let repo: jest.Mocked<CollectionsRepository>;

    const mockUserId = '11111111-1111-1111-1111-111111111111';

    beforeEach(async () => {
      const mockRepo = {
        findAll: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CollectionsService,
          { provide: CollectionsRepository, useValue: mockRepo },
          { provide: PrismaService, useValue: {} },
          TreeEngine,
        ],
      }).compile();

      service = module.get<CollectionsService>(CollectionsService);
      repo = module.get(CollectionsRepository);
    });

    it('should throw UnprocessableEntityException when creating collection with empty name', async () => {
      await expect(
        service.createCollection(mockUserId, {
          name: '   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      await expect(
        service.createCollection(mockUserId, {
          name: '<script>alert(1)</script>',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should sanitize name and description on createCollection', async () => {
      repo.create.mockResolvedValue({
        id: 'col-new',
        name: 'Neural Models',
        description: 'Clean description',
        parentId: null,
      } as any);

      const result = await service.createCollection(mockUserId, {
        name: '<script>evil()</script>Neural Models',
        description: '<b>Clean</b> description',
      });

      expect(repo.create).toHaveBeenCalledWith(
        mockUserId,
        mockUserId,
        expect.objectContaining({
          name: 'Neural Models',
          description: 'Clean description',
        }),
      );
      expect(result.collection).toBeDefined();
    });

    it('should throw UnprocessableEntityException when updating collection with empty name', async () => {
      repo.findById.mockResolvedValue({ id: 'col-1', name: 'Existing' } as any);

      await expect(
        service.updateCollection(mockUserId, 'col-1', {
          name: '   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should reject circular parent update in CollectionsService', async () => {
      repo.findById
        .mockResolvedValueOnce({
          id: 'col-A',
          name: 'A',
          parentId: null,
        } as any) // existing target
        .mockResolvedValueOnce({
          id: 'col-B',
          name: 'B',
          parentId: 'col-A',
        } as any); // candidate parent

      repo.findAll.mockResolvedValue([
        { id: 'col-A', name: 'A', parentId: null },
        { id: 'col-B', name: 'B', parentId: 'col-A' },
      ] as any);

      await expect(
        service.updateCollection(mockUserId, 'col-A', {
          parentId: 'col-B',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
