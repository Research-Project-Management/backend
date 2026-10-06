import { RankHandler } from '@/modules/work-item/core/handlers/rank.handler';

describe('RankHandler - Algorithmic Reorder Optimization', () => {
  let rankHandler: RankHandler;

  beforeEach(() => {
    rankHandler = new RankHandler();
  });

  it('should only update dirty rows when moving an item within the same column', () => {
    // 5 items in column-A, with ranks 0..4
    const columnItems = [
      { id: 'item-0', columnId: 'col-A', rank: 0 },
      { id: 'item-1', columnId: 'col-A', rank: 1 },
      { id: 'item-2', columnId: 'col-A', rank: 2 },
      { id: 'item-3', columnId: 'col-A', rank: 3 },
      { id: 'item-4', columnId: 'col-A', rank: 4 },
    ];

    // Move item-1 to rank 3
    // Expected new order: item-0 (rank 0), item-2 (rank 1), item-3 (rank 2), item-1 (rank 3), item-4 (rank 4)
    // Only item-1, item-2, and item-3 shifted! item-0 and item-4 remained unchanged.
    const updates = rankHandler.calculateReorder(
      columnItems,
      'item-1',
      'col-A',
      3,
      () => false,
    );

    expect(updates).toHaveLength(3);
    const updatedIds = updates.map((u) => u.id);
    expect(updatedIds).toEqual(['item-2', 'item-3', 'item-1']);

    expect(updates.find((u) => u.id === 'item-1')?.rank).toBe(3);
    expect(updates.find((u) => u.id === 'item-2')?.rank).toBe(1);
    expect(updates.find((u) => u.id === 'item-3')?.rank).toBe(2);
  });

  it('should update moved item and shifted suffix when moving to another column', () => {
    // Target column col-B has 3 items: ranks 0, 1, 2
    const targetColumnItems = [
      { id: 'b-0', columnId: 'col-B', rank: 0 },
      { id: 'b-1', columnId: 'col-B', rank: 1 },
      { id: 'b-2', columnId: 'col-B', rank: 2 },
    ];

    const movingItem = { id: 'a-9', columnId: 'col-A', rank: 0 };

    // Move a-9 into col-B at target rank 1
    // Expected new order: b-0 (rank 0), a-9 (rank 1), b-1 (rank 2), b-2 (rank 3)
    // b-0 is unchanged! Only a-9, b-1, and b-2 should update.
    const updates = rankHandler.calculateReorder(
      targetColumnItems,
      'a-9',
      'col-B',
      1,
      () => true,
      movingItem,
    );

    expect(updates).toHaveLength(3);
    expect(updates.find((u) => u.id === 'a-9')).toMatchObject({
      id: 'a-9',
      rank: 1,
      columnId: 'col-B',
      completed: true,
    });
    expect(updates.find((u) => u.id === 'b-1')?.rank).toBe(2);
    expect(updates.find((u) => u.id === 'b-2')?.rank).toBe(3);
    expect(updates.find((u) => u.id === 'b-0')).toBeUndefined();
  });

  it('should clamp out-of-bounds rank to column boundary', () => {
    const columnItems = [
      { id: 'item-0', columnId: 'col-A', rank: 0 },
      { id: 'item-1', columnId: 'col-A', rank: 1 },
    ];

    const updates = rankHandler.calculateReorder(
      columnItems,
      'item-0',
      'col-A',
      999, // out of bounds
      () => false,
    );

    // item-0 moves from 0 to 1, item-1 moves from 1 to 0
    expect(updates).toHaveLength(2);
    expect(updates.find((u) => u.id === 'item-0')?.rank).toBe(1);
    expect(updates.find((u) => u.id === 'item-1')?.rank).toBe(0);
  });
});
