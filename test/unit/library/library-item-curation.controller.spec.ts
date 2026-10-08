import { ItemCurationController } from '@/modules/library/catalog/controllers/item-curation.controller';

describe('ItemCurationController (Scholarly Curation & Academic Enrichment Adapter)', () => {
  let controller: ItemCurationController;
  let mockItemService: {
    getFulltext: jest.Mock;
    parseCitations: jest.Mock;
    reindexItem: jest.Mock;
    getItem: jest.Mock;
    previewTypeConversion: jest.Mock;
    convertItemType: jest.Mock;
    getRelatedItems: jest.Mock;
    linkItems: jest.Mock;
    unlinkItems: jest.Mock;
    setMyPublication: jest.Mock;
  };

  const validUuid = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mockItemService = {
      getFulltext: jest.fn().mockResolvedValue({
        title: 'Attention Is All You Need',
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: [],
      }),
      parseCitations: jest
        .fn()
        .mockResolvedValue([
          { title: 'Attention Is All You Need', authors: ['Vaswani'] },
        ]),
      reindexItem: jest.fn().mockResolvedValue({
        success: true,
        message: 'Item reindexed in vector and fulltext index',
      }),
      getItem: jest.fn().mockResolvedValue({
        id: validUuid,
        title: 'Test Paper',
      }),
      previewTypeConversion: jest.fn().mockReturnValue({
        targetType: 'book',
        mappedFields: { title: 'Test Paper' },
        unmappedFields: {},
      }),
      convertItemType: jest.fn().mockResolvedValue({
        item: { id: validUuid, itemType: 'book' },
        conversionReport: {
          mappedFields: ['title', 'authors'],
          unmappedFields: [],
        },
      }),
      getRelatedItems: jest
        .fn()
        .mockResolvedValue([{ id: 'rel-1', title: 'Related Paper' }]),
      linkItems: jest.fn().mockResolvedValue({ success: true, linkCount: 1 }),
      unlinkItems: jest.fn().mockResolvedValue({ success: true }),
      setMyPublication: jest
        .fn()
        .mockImplementation((userId, id, isMyPublication) =>
          Promise.resolve({ id, isMyPublication }),
        ),
    };

    controller = new ItemCurationController(mockItemService as any);
  });

  it('should parse citations using ItemService', async () => {
    const res = await controller.parseCitations({
      citations: 'Vaswani et al., 2017. Attention Is All You Need.',
    });
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(mockItemService.parseCitations).toHaveBeenCalledWith(
      'Vaswani et al., 2017. Attention Is All You Need.',
    );
  });

  it('should get fulltext using ItemService', async () => {
    const res = await controller.getFulltext(validUuid, 'user-1', 'proj-1');
    expect(res.success).toBe(true);
    expect(res.data.title).toBe('Attention Is All You Need');
    expect(mockItemService.getFulltext).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'proj-1',
    );
  });

  it('should trigger reindexing using ItemService', async () => {
    const res = await controller.reindexItem(validUuid, 'user-1', 'proj-1');
    expect(res.success).toBe(true);
    expect(mockItemService.reindexItem).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'proj-1',
    );
  });

  it('should preview type conversion using ItemService', async () => {
    const res = await controller.previewTypeConversion(
      validUuid,
      'user-1',
      { targetType: 'book' },
      'proj-1',
    );
    expect(res.success).toBe(true);
    expect(res.preview.targetType).toBe('book');
    expect(mockItemService.getItem).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'proj-1',
    );
  });

  it('should execute convertItemType using ItemService', async () => {
    const res = await controller.convertItemType(
      validUuid,
      'user-1',
      undefined,
      { targetType: 'book' },
      'proj-1',
    );
    expect(res.success).toBe(true);
    expect(res.item.itemType).toBe('book');
    expect(mockItemService.convertItemType).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'book',
      {
        expectedVersion: undefined,
        retainUnmappedInExtra: true,
      },
    );
  });

  it('should manage relations (get, link, unlink)', async () => {
    const related = await controller.getRelatedItems(
      validUuid,
      'user-1',
      'proj-1',
    );
    expect(related).toHaveLength(1);
    expect(mockItemService.getRelatedItems).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'proj-1',
    );

    const linked = await controller.linkItems(
      validUuid,
      { targetItemId: 'target-uuid', relationType: 'cites' },
      'user-1',
      'proj-1',
    );
    expect(linked.success).toBe(true);
    expect(mockItemService.linkItems).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      { targetItemId: 'target-uuid', relationType: 'cites' },
      'proj-1',
    );

    const unlinked = await controller.unlinkItems(
      validUuid,
      'target-uuid',
      'user-1',
      'proj-1',
    );
    expect(unlinked.success).toBe(true);
    expect(mockItemService.unlinkItems).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      'target-uuid',
      'proj-1',
    );
  });

  it('should mark and unmark my publication using ItemService', async () => {
    const marked = await controller.markMyPublication(validUuid, 'user-1');
    expect(marked.success).toBe(true);
    expect(mockItemService.setMyPublication).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      true,
    );

    const unmarked = await controller.unmarkMyPublication(validUuid, 'user-1');
    expect(unmarked.success).toBe(true);
    expect(mockItemService.setMyPublication).toHaveBeenCalledWith(
      'user-1',
      validUuid,
      false,
    );
  });
});
