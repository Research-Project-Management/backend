import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConditionEvaluatorEngine } from '../../src/modules/library/catalog/application/engines/condition-evaluator.engine';
import { SavedSearchesService } from '../../src/modules/library/catalog/application/services/saved-searches.service';
import { SavedSearchesRepository } from '../../src/modules/library/catalog/infrastructure/repositories/saved-searches.repository';
import { SavedSearchConditionGroup } from '../../src/modules/library/catalog/domain/types/saved-search.types';

describe('Library Saved Searches & ConditionEvaluatorEngine', () => {
  let engine: ConditionEvaluatorEngine;
  let service: SavedSearchesService;
  let mockRepo: any;

  const mockUserId = 'user-uuid-111';
  const mockProjectId = 'proj-uuid-222';

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      update: jest.fn(),
      updateCachedCount: jest.fn().mockResolvedValue({} as any),
      softDelete: jest.fn(),
      countMatchingItems: jest.fn().mockResolvedValue(5),
      findMatchingItems: jest.fn().mockResolvedValue({
        items: [{ id: 'item-1', title: 'Paper 1' }] as any,
        nextCursor: undefined,
        hasNextPage: false,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConditionEvaluatorEngine,
        SavedSearchesService,
        { provide: SavedSearchesRepository, useValue: mockRepo },
      ],
    }).compile();

    engine = module.get<ConditionEvaluatorEngine>(ConditionEvaluatorEngine);
    service = module.get<SavedSearchesService>(SavedSearchesService);
  });

  describe('ConditionEvaluatorEngine - Multi-Tenant Scoping', () => {
    it('should compile baseWhere with userId when projectId is omitted (personal library)', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'title', operator: 'contains', value: 'Quantum' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      expect(result).toEqual({
        AND: [
          { userId: mockUserId, deletedAt: null },
          {
            AND: [{ title: { contains: 'Quantum', mode: 'insensitive' } }],
          },
        ],
      });
    });

    it('should compile baseWhere with projectId when projectId is specified (collaborative project library)', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'title', operator: 'contains', value: 'Machine Learning' },
        ],
      };

      const result = engine.compile(mockUserId, group, mockProjectId);
      expect(result).toEqual({
        AND: [
          { projectId: mockProjectId, deletedAt: null },
          {
            AND: [
              { title: { contains: 'Machine Learning', mode: 'insensitive' } },
            ],
          },
        ],
      });
    });

    it('should return baseWhere if conditions group is empty', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [],
      };

      const personalResult = engine.compile(mockUserId, group);
      expect(personalResult).toEqual({ userId: mockUserId, deletedAt: null });

      const projectResult = engine.compile(mockUserId, group, mockProjectId);
      expect(projectResult).toEqual({
        projectId: mockProjectId,
        deletedAt: null,
      });
    });
  });

  describe('ConditionEvaluatorEngine - Operators & Fields Coverage', () => {
    it('should evaluate title string operators (beginsWith, endsWith, isPresent, isAbsent)', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'OR',
        conditions: [
          { field: 'title', operator: 'beginsWith', value: 'Intro' },
          { field: 'title', operator: 'endsWith', value: 'Survey' },
          { field: 'title', operator: 'isPresent' },
          { field: 'title', operator: 'isAbsent' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].OR;

      expect(clauses[0]).toEqual({
        title: { startsWith: 'Intro', mode: 'insensitive' },
      });
      expect(clauses[1]).toEqual({
        title: { endsWith: 'Survey', mode: 'insensitive' },
      });
      expect(clauses[2]).toEqual({
        AND: [{ title: { not: null } }, { title: { not: '' } }],
      });
      expect(clauses[3]).toEqual({
        OR: [{ title: null }, { title: '' }],
      });
    });

    it('should evaluate creator operators including beginsWith and endsWith', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'creator', operator: 'beginsWith', value: 'Albert' },
          { field: 'creator', operator: 'endsWith', value: 'Einstein' },
          { field: 'creator', operator: 'isPresent' },
          { field: 'creator', operator: 'isAbsent' },
          { field: 'creator', operator: 'doesNotContain', value: 'Newton' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({
        contributors: {
          some: { fullName: { startsWith: 'Albert', mode: 'insensitive' } },
        },
      });
      expect(clauses[1]).toEqual({
        contributors: {
          some: { fullName: { endsWith: 'Einstein', mode: 'insensitive' } },
        },
      });
      expect(clauses[2]).toEqual({ contributors: { some: {} } });
      expect(clauses[3]).toEqual({ contributors: { none: {} } });
      expect(clauses[4]).toEqual({
        NOT: {
          contributors: {
            some: { fullName: { contains: 'Newton', mode: 'insensitive' } },
          },
        },
      });
    });

    it('should evaluate year operators and guard against NaN', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'year', operator: 'is', value: 2024 },
          { field: 'year', operator: 'isGreaterThan', value: '2020' },
          { field: 'year', operator: 'isLessThan', value: 2025 },
          { field: 'year', operator: 'isBetween', value: [2018, 2023] },
          { field: 'year', operator: 'isPresent' },
          { field: 'year', operator: 'isAbsent' },
          { field: 'year', operator: 'is', value: 'not-a-number' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({ year: 2024 });
      expect(clauses[1]).toEqual({ year: { gt: 2020 } });
      expect(clauses[2]).toEqual({ year: { lt: 2025 } });
      expect(clauses[3]).toEqual({ year: { gte: 2018, lte: 2023 } });
      expect(clauses[4]).toEqual({ year: { not: null } });
      expect(clauses[5]).toEqual({ year: null });
      expect(clauses.length).toBe(6);
    });

    it('should evaluate itemType operators (is, isNot, contains, doesNotContain)', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'itemType', operator: 'is', value: 'journalArticle' },
          { field: 'itemType', operator: 'isNot', value: 'book' },
          { field: 'itemType', operator: 'contains', value: 'Article' },
          { field: 'itemType', operator: 'doesNotContain', value: 'Thesis' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({ itemType: 'journalArticle' });
      expect(clauses[1]).toEqual({ NOT: { itemType: 'book' } });
      expect(clauses[2]).toEqual({
        itemType: { contains: 'Article', mode: 'insensitive' },
      });
      expect(clauses[3]).toEqual({
        NOT: { itemType: { contains: 'Thesis', mode: 'insensitive' } },
      });
    });

    it('should evaluate tag operators with beginsWith and endsWith', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'tag', operator: 'beginsWith', value: 'AI/' },
          { field: 'tag', operator: 'endsWith', value: '/v1' },
          { field: 'tag', operator: 'contains', value: 'DeepLearning' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({
        itemTags: {
          some: { tag: { name: { startsWith: 'AI/', mode: 'insensitive' } } },
        },
      });
      expect(clauses[1]).toEqual({
        itemTags: {
          some: { tag: { name: { endsWith: '/v1', mode: 'insensitive' } } },
        },
      });
      expect(clauses[2]).toEqual({
        itemTags: {
          some: {
            tag: { name: { contains: 'DeepLearning', mode: 'insensitive' } },
          },
        },
      });
    });

    it('should evaluate readStatus for is and isNot operators', () => {
      const unreadGroup: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [{ field: 'readStatus', operator: 'is', value: 'unread' }],
      };
      const unreadRes = engine.compile(mockUserId, unreadGroup);
      expect((unreadRes as any).AND[1].AND[0]).toEqual({
        OR: [
          { states: { none: { userId: mockUserId } } },
          { states: { some: { userId: mockUserId, readStatus: 'unread' } } },
        ],
      });

      const notUnreadGroup: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'readStatus', operator: 'isNot', value: 'unread' },
        ],
      };
      const notUnreadRes = engine.compile(mockUserId, notUnreadGroup);
      expect((notUnreadRes as any).AND[1].AND[0]).toEqual({
        states: {
          some: {
            userId: mockUserId,
            readStatus: { not: 'unread' },
          },
        },
      });

      const notReadGroup: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [{ field: 'readStatus', operator: 'isNot', value: 'read' }],
      };
      const notReadRes = engine.compile(mockUserId, notReadGroup);
      expect((notReadRes as any).AND[1].AND[0]).toEqual({
        OR: [
          { states: { none: { userId: mockUserId } } },
          {
            states: {
              some: { userId: mockUserId, readStatus: { not: 'read' } },
            },
          },
        ],
      });
    });

    it('should evaluate rating operators (is, isNot, isGreaterThan, isLessThan, isBetween, isPresent, isAbsent)', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          { field: 'rating', operator: 'is', value: 5 },
          { field: 'rating', operator: 'isGreaterThan', value: 3 },
          { field: 'rating', operator: 'isLessThan', value: 2 },
          { field: 'rating', operator: 'isBetween', value: [3, 5] },
          { field: 'rating', operator: 'isPresent' },
          { field: 'rating', operator: 'isAbsent' },
          { field: 'rating', operator: 'isNot', value: 1 },
          { field: 'rating', operator: 'is', value: 'invalid-rating' },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({
        states: { some: { userId: mockUserId, rating: 5 } },
      });
      expect(clauses[1]).toEqual({
        states: { some: { userId: mockUserId, rating: { gt: 3 } } },
      });
      expect(clauses[2]).toEqual({
        states: { some: { userId: mockUserId, rating: { lt: 2 } } },
      });
      expect(clauses[3]).toEqual({
        states: { some: { userId: mockUserId, rating: { gte: 3, lte: 5 } } },
      });
      expect(clauses[4]).toEqual({
        states: { some: { userId: mockUserId, rating: { not: null, gt: 0 } } },
      });
      expect(clauses[5]).toEqual({
        OR: [
          { states: { none: { userId: mockUserId } } },
          {
            states: {
              some: {
                userId: mockUserId,
                OR: [{ rating: null }, { rating: 0 }],
              },
            },
          },
        ],
      });
      expect(clauses[6]).toEqual({
        OR: [
          { states: { none: { userId: mockUserId } } },
          { states: { some: { userId: mockUserId, NOT: { rating: 1 } } } },
        ],
      });
      expect(clauses.length).toBe(7);
    });

    it('should evaluate dateAdded operators and guard against invalid dates', () => {
      const group: SavedSearchConditionGroup = {
        conjunction: 'AND',
        conditions: [
          {
            field: 'dateAdded',
            operator: 'isGreaterThan',
            value: '2024-01-01T00:00:00.000Z',
          },
          {
            field: 'dateAdded',
            operator: 'isLessThan',
            value: '2024-12-31T23:59:59.999Z',
          },
          {
            field: 'dateAdded',
            operator: 'isBetween',
            value: ['2024-01-01', '2024-06-01'],
          },
          {
            field: 'dateAdded',
            operator: 'isGreaterThan',
            value: 'invalid-date-string',
          },
        ],
      };

      const result = engine.compile(mockUserId, group);
      const clauses = (result as any).AND[1].AND;

      expect(clauses[0]).toEqual({
        createdAt: { gt: new Date('2024-01-01T00:00:00.000Z') },
      });
      expect(clauses[1]).toEqual({
        createdAt: { lt: new Date('2024-12-31T23:59:59.999Z') },
      });
      expect(clauses[2]).toEqual({
        createdAt: { gte: new Date('2024-01-01'), lte: new Date('2024-06-01') },
      });
      expect(clauses.length).toBe(3);
    });
  });

  describe('SavedSearchesService - CRUD and Multi-Tenant Project Operations', () => {
    it('should create personal saved search with null projectId and count initial items', async () => {
      mockRepo.create.mockResolvedValue({
        id: 'search-1',
        userId: mockUserId,
        projectId: null,
        name: 'My Personal Smart Collection',
        cachedCount: 0,
      } as any);

      const dto = {
        name: 'My Personal Smart Collection',
        conditions: {
          conjunction: 'AND' as const,
          conditions: [
            {
              field: 'year' as const,
              operator: 'isGreaterThan' as const,
              value: 2020,
            },
          ],
        },
      };

      const result = await service.create(mockUserId, dto);
      expect(mockRepo.create).toHaveBeenCalledWith(mockUserId, dto, undefined);
      expect(mockRepo.countMatchingItems).toHaveBeenCalled();
      expect(result.cachedCount).toBe(5);
    });

    it('should create project saved search with projectId and evaluate count within project scope', async () => {
      mockRepo.create.mockResolvedValue({
        id: 'search-2',
        userId: mockUserId,
        projectId: mockProjectId,
        name: 'Project Smart Collection',
        cachedCount: 0,
      } as any);

      const dto = {
        name: 'Project Smart Collection',
        projectId: mockProjectId,
        conditions: {
          conjunction: 'AND' as const,
          conditions: [
            { field: 'tag' as const, operator: 'is' as const, value: 'AI' },
          ],
        },
      };

      const result = await service.create(mockUserId, dto, mockProjectId);
      expect(mockRepo.create).toHaveBeenCalledWith(
        mockUserId,
        dto,
        mockProjectId,
      );
      expect(result.cachedCount).toBe(5);
    });

    it('should throw NotFoundException when finding non-existent saved search', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(
        service.findById(mockUserId, 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should preview saved search results and sample items with project scope', async () => {
      const dto = {
        conditions: {
          conjunction: 'AND' as const,
          conditions: [
            {
              field: 'hasAttachment' as const,
              operator: 'is' as const,
              value: true,
            },
          ],
        },
        projectId: mockProjectId,
      };

      const preview = await service.preview(mockUserId, dto, mockProjectId);
      expect(preview.count).toBe(5);
      expect(preview.sampleItems).toHaveLength(1);
    });

    it('should execute saved search and return paginated items with updated count', async () => {
      mockRepo.findById.mockResolvedValue({
        id: 'search-exec',
        userId: mockUserId,
        projectId: mockProjectId,
        name: 'Project Review',
        conditions: {
          conjunction: 'AND' as const,
          conditions: [
            {
              field: 'readStatus' as const,
              operator: 'is' as const,
              value: 'unread',
            },
          ],
        },
        sortBy: 'dateAdded',
        sortOrder: 'desc',
      } as any);

      const res = await service.execute(
        mockUserId,
        'search-exec',
        { limit: 20 },
        mockProjectId,
      );

      expect(res.savedSearch.id).toBe('search-exec');
      expect(res.items).toHaveLength(1);
      expect(res.meta.totalCount).toBe(5);
      expect(mockRepo.updateCachedCount).toHaveBeenCalledWith('search-exec', 5);
    });
  });
});
