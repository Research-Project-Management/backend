import { CommandRepository } from '../../src/modules/library/items/repositories/command.repository';
import { QueryRepository } from '../../src/modules/library/items/repositories/query.repository';

describe('My Publications Unit Tests', () => {
  describe('QueryRepository - buildWhereClause', () => {
    let queryRepo: QueryRepository;
    const mockPrisma: any = {};
    const userId = '00000000-0000-0000-0000-000000000001';

    beforeEach(() => {
      queryRepo = new QueryRepository(mockPrisma);
    });

    it('filters isMyPublication = true when view is my-publications', () => {
      const where = queryRepo.buildWhereClause(userId, {
        view: 'my-publications',
      });

      expect(where.userId).toBe(userId);
      expect(where.deletedAt).toBeNull();
      expect(where.isMyPublication).toBe(true);
    });

    it('filters isMyPublication = true when view is publications', () => {
      const where = queryRepo.buildWhereClause(userId, {
        view: 'publications',
      });

      expect(where.userId).toBe(userId);
      expect(where.deletedAt).toBeNull();
      expect(where.isMyPublication).toBe(true);
    });

    it('does not filter isMyPublication when view is all', () => {
      const where = queryRepo.buildWhereClause(userId, {
        view: 'all',
      });

      expect(where.userId).toBe(userId);
      expect(where.deletedAt).toBeNull();
      expect(where.isMyPublication).toBeUndefined();
    });
  });

  describe('CommandRepository - setMyPublication', () => {
    let commandRepo: CommandRepository;
    let mockPrisma: any;
    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const itemId = 'item-123';

    beforeEach(() => {
      mockPrisma = {
        item: {
          findFirst: jest.fn(),
          update: jest.fn(),
        },
      };
      commandRepo = new CommandRepository(mockPrisma);
    });

    it('marks item as my publication and sets confirmation timestamp', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        workspaceId,
        deletedAt: null,
      });

      mockPrisma.item.update.mockResolvedValue({
        id: itemId,
        isMyPublication: true,
        publicationConfirmedAt: new Date(),
        version: 2,
      });

      const result = await commandRepo.setMyPublication(
        workspaceId,
        itemId,
        true,
      );

      expect(result.isMyPublication).toBe(true);
      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: itemId },
          data: expect.objectContaining({
            isMyPublication: true,
            publicationConfirmedAt: expect.any(Date),
            version: { increment: 1 },
          }),
        }),
      );
    });

    it('unmarks item as my publication and clears confirmation timestamp', async () => {
      mockPrisma.item.findFirst.mockResolvedValue({
        id: itemId,
        workspaceId,
        deletedAt: null,
      });

      mockPrisma.item.update.mockResolvedValue({
        id: itemId,
        isMyPublication: false,
        publicationConfirmedAt: null,
        version: 3,
      });

      const result = await commandRepo.setMyPublication(
        workspaceId,
        itemId,
        false,
      );

      expect(result.isMyPublication).toBe(false);
      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: itemId },
          data: expect.objectContaining({
            isMyPublication: false,
            publicationConfirmedAt: null,
            version: { increment: 1 },
          }),
        }),
      );
    });
  });
});
