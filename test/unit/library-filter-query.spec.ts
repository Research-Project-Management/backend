import { QueryRepository } from '@/modules/library/catalog/core/adapters/query.repository';

describe('QueryRepository Filtering & Grounding Specification', () => {
  let queryRepo: QueryRepository;
  const mockPrisma: any = {
    item: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  };

  beforeEach(() => {
    queryRepo = new QueryRepository(mockPrisma);
  });

  describe('buildWhereClause (Grounded Filter Invariants)', () => {
    const userId = '11111111-1111-4111-8111-111111111111';

    it('should build where clause for personal scope by default', () => {
      const where: any = queryRepo.buildWhereClause(userId, { view: 'all' });
      expect(where.userId).toBe(userId);
      expect(where.projectId).toBeNull();
      expect(where.deletedAt).toBeNull();
    });

    it('should build where clause for project scope when valid projectId is provided', () => {
      const projectId = '22222222-2222-4222-8222-222222222222';
      const where: any = queryRepo.buildWhereClause(userId, {
        view: 'all',
        projectId,
      });
      expect(where.projectId).toBe(projectId);
      expect(where.userId).toBeUndefined();
      expect(where.deletedAt).toBeNull();
    });

    it('should support single readStatus filtering', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        readStatus: 'unread',
      });
      expect(where.states).toEqual({
        some: {
          userId,
          readStatus: 'unread',
        },
      });
    });

    it('should support comma-separated multi-select readStatus filtering', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        readStatus: 'unread,reading',
      });
      expect(where.states).toEqual({
        some: {
          userId,
          readStatus: { in: ['unread', 'reading'] },
        },
      });
    });

    it('should support comma-separated multi-select itemType filtering', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        type: 'journalArticle,preprint',
      });
      expect(where.itemType).toEqual({
        in: ['journalArticle', 'preprint'],
      });
    });

    it('should support year range filtering', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        fromYear: 2022,
        toYear: 2026,
      });
      expect(where.year).toEqual({
        gte: 2022,
        lte: 2026,
      });
    });

    it('should support hasFile boolean filtering', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        hasFile: true,
      });
      expect(where.hasFile).toBe(true);
    });

    it('should combine my-publications view and search within AND array without overwriting', () => {
      const where: any = queryRepo.buildWhereClause(userId, {
        view: 'my-publications',
        search: 'quantum computing',
      });
      expect(where.AND).toBeDefined();
      expect(where.AND).toHaveLength(2);
      // First condition is view 'my-publications'
      expect(where.AND[0].OR).toEqual([
        { metadata: { path: ['isMyPublication'], equals: true } },
        { publications: { some: { userId } } },
      ]);
      // Second condition is search
      expect(where.AND[1].OR).toBeDefined();
      expect(where.AND[1].OR[0]).toEqual({
        title: { contains: 'quantum computing', mode: 'insensitive' },
      });
    });
  });

  describe('findMany Sorting & Whitelisting', () => {
    const userId = '11111111-1111-4111-8111-111111111111';

    it('should map authors sort to firstAuthor', async () => {
      mockPrisma.item.findMany.mockResolvedValueOnce([]);
      await queryRepo.findMany(userId, {
        orderBy: 'authors',
        orderDirection: 'asc',
      });

      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ firstAuthor: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('should map publication sort to publicationTitle', async () => {
      mockPrisma.item.findMany.mockResolvedValueOnce([]);
      await queryRepo.findMany(userId, {
        orderBy: 'publication',
        orderDirection: 'desc',
      });

      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ publicationTitle: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('should allow explicit publicationTitle sorting', async () => {
      mockPrisma.item.findMany.mockResolvedValueOnce([]);
      await queryRepo.findMany(userId, {
        orderBy: 'publicationTitle',
        orderDirection: 'asc',
      });

      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ publicationTitle: 'asc' }, { id: 'asc' }],
        }),
      );
    });
  });
});
