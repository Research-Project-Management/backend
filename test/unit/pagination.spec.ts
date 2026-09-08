import { ItemsService } from '../../src/modules/library/items/items.service';
import { ItemQueryRepository } from '../../src/modules/library/items/repositories/item-query.repository';

describe('P1 Cursor Pagination Correctness', () => {
  let itemsService: ItemsService;
  let mockQueryRepo: Partial<ItemQueryRepository>;

  const workspaceId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    mockQueryRepo = {
      count: jest.fn().mockResolvedValue(5),
      findMany: jest.fn(),
    };

    const mockPrisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ id: workspaceId }),
      },
    };

    itemsService = new ItemsService(
      mockQueryRepo as any,
      {} as any, // commandRepo
      {} as any, // libraryTx
      mockPrisma as any,
      {} as any, // tagsService
      {} as any, // collectionsService
      {} as any, // typesService
      {} as any, // ragIndexer
    );
  });

  it('sets nextCursor to the LAST RETURNED item, not the popped overflow item', async () => {
    // Database returns 3 items when limit is 2 (limit + 1 = 3)
    const dbItems = [
      { id: 'item-1', title: 'First Item', userStates: [] },
      { id: 'item-2', title: 'Second Item', userStates: [] },
      { id: 'item-3', title: 'Third Item (Overflow)', userStates: [] },
    ];

    (mockQueryRepo.findMany as jest.Mock).mockResolvedValueOnce([...dbItems]);

    const result = await itemsService.listItems(workspaceId, { limit: 2 });

    // Must return exactly 2 items
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe('item-1');
    expect(result.items[1].id).toBe('item-2');

    // hasNextPage must be true
    expect(result.meta.hasNextPage).toBe(true);

    // CRITICAL: nextCursor must be item-2 (the last item on page 1), NOT item-3 (the overflow item)
    // because Prisma cursor pagination uses { cursor: { id: cursor }, skip: 1 },
    // so sending item-2 will skip item-2 and start at item-3!
    expect(result.meta.cursor).toBe('item-2');
  });

  it('sets nextCursor to undefined and hasNextPage to false on the final page', async () => {
    // Database returns <= limit items
    const dbItems = [{ id: 'item-3', title: 'Third Item', userStates: [] }];

    (mockQueryRepo.findMany as jest.Mock).mockResolvedValueOnce([...dbItems]);

    const result = await itemsService.listItems(workspaceId, {
      limit: 2,
      cursor: 'item-2',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('item-3');
    expect(result.meta.hasNextPage).toBe(false);
    expect(result.meta.cursor).toBeUndefined();
  });
});
