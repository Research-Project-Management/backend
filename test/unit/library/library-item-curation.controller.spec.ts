import { ItemCurationController } from '@/modules/library/catalog/item-curation.controller';

describe('ItemCurationController (Scholarly Curation & Academic Enrichment Adapter)', () => {
  let controller: ItemCurationController;
  let mockGetFulltextUseCase: { execute: jest.Mock };
  let mockParseCitationsUseCase: { execute: jest.Mock };
  let mockReindexItemUseCase: { execute: jest.Mock };
  let mockConvertItemTypeUseCase: { execute: jest.Mock };
  let mockPreviewTypeConversionUseCase: { execute: jest.Mock };
  let mockManageRelationsUseCase: {
    getRelatedItems: jest.Mock;
    linkItems: jest.Mock;
    unlinkItems: jest.Mock;
  };
  let mockSetMyPublicationUseCase: { execute: jest.Mock };
  let mockGetItemUseCase: { execute: jest.Mock };

  const validUuid = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mockGetFulltextUseCase = {
      execute: jest.fn().mockResolvedValue({
        title: 'Attention Is All You Need',
        sections: [],
        figures: [],
        tables: [],
        formulas: [],
        references: [],
      }),
    };
    mockParseCitationsUseCase = {
      execute: jest.fn().mockResolvedValue({
        count: 1,
        references: [
          { title: 'Attention Is All You Need', authors: ['Vaswani'] },
        ],
      }),
    };
    mockReindexItemUseCase = {
      execute: jest.fn().mockResolvedValue({
        success: true,
        message: 'Item reindexed in vector and fulltext index',
      }),
    };
    mockConvertItemTypeUseCase = {
      execute: jest.fn().mockResolvedValue({
        item: { id: validUuid, itemType: 'book' },
        conversionReport: {
          mappedFields: ['title', 'authors'],
          unmappedFields: [],
        },
      }),
    };
    mockPreviewTypeConversionUseCase = {
      execute: jest.fn().mockReturnValue({
        targetType: 'book',
        mappedFields: { title: 'Test Paper' },
        unmappedFields: {},
      }),
    };
    mockManageRelationsUseCase = {
      getRelatedItems: jest
        .fn()
        .mockResolvedValue([{ id: 'rel-1', title: 'Related Paper' }]),
      linkItems: jest.fn().mockResolvedValue({ success: true, linkCount: 1 }),
      unlinkItems: jest.fn().mockResolvedValue({ success: true }),
    };
    mockSetMyPublicationUseCase = {
      execute: jest
        .fn()
        .mockResolvedValue({ id: validUuid, isMyPublication: true }),
    };
    mockGetItemUseCase = {
      execute: jest
        .fn()
        .mockResolvedValue({ id: validUuid, title: 'Test Paper' }),
    };

    controller = new ItemCurationController(
      mockGetFulltextUseCase as any,
      mockParseCitationsUseCase as any,
      mockReindexItemUseCase as any,
      mockConvertItemTypeUseCase as any,
      mockPreviewTypeConversionUseCase as any,
      mockManageRelationsUseCase as any,
      mockSetMyPublicationUseCase as any,
      mockGetItemUseCase as any,
      undefined,
    );
  });

  it('should parse citations using ParseCitationsUseCase', async () => {
    const res = await controller.parseCitations({
      citations: 'Vaswani et al., 2017. Attention Is All You Need.',
    });
    expect(res.success).toBe(true);
    expect(res.count).toBe(1);
    expect(mockParseCitationsUseCase.execute).toHaveBeenCalledWith({
      rawCitations: 'Vaswani et al., 2017. Attention Is All You Need.',
    });
  });

  it('should get fulltext using GetFulltextUseCase', async () => {
    const res = await controller.getFulltext(validUuid, 'user-1', 'proj-1');
    expect(res.success).toBe(true);
    expect(res.data.title).toBe('Attention Is All You Need');
    expect(mockGetFulltextUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      projectId: 'proj-1',
    });
  });

  it('should trigger reindexing using ReindexItemUseCase', async () => {
    const res = await controller.reindexItem(validUuid, 'user-1', 'proj-1');
    expect(res.success).toBe(true);
    expect(mockReindexItemUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      projectId: 'proj-1',
    });
  });

  it('should preview type conversion using PreviewTypeConversionUseCase', async () => {
    const res = await controller.previewTypeConversion(
      validUuid,
      'user-1',
      { targetType: 'book' },
      'proj-1',
    );
    expect(res.success).toBe(true);
    expect(res.preview.targetType).toBe('book');
  });

  it('should execute convertItemType using ConvertItemTypeUseCase', async () => {
    const res = await controller.convertItemType(
      validUuid,
      'user-1',
      undefined,
      { targetType: 'book' },
      'proj-1',
    );
    expect(res.success).toBe(true);
    expect(res.item.itemType).toBe('book');
    expect(mockConvertItemTypeUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      targetType: 'book',
      options: {
        expectedVersion: undefined,
        retainUnmappedInExtra: true,
      },
      projectId: 'proj-1',
    });
  });

  it('should manage relations (get, link, unlink)', async () => {
    const related = await controller.getRelatedItems(
      validUuid,
      'user-1',
      'proj-1',
    );
    expect(related).toHaveLength(1);

    const linked = await controller.linkItems(
      validUuid,
      { targetItemId: 'target-uuid', relationType: 'cites' },
      'user-1',
      'proj-1',
    );
    expect(linked.success).toBe(true);

    const unlinked = await controller.unlinkItems(
      validUuid,
      'target-uuid',
      'user-1',
      'proj-1',
    );
    expect(unlinked.success).toBe(true);
  });

  it('should mark and unmark my publication using SetMyPublicationUseCase', async () => {
    const marked = await controller.markMyPublication(validUuid, 'user-1');
    expect(marked.success).toBe(true);
    expect(mockSetMyPublicationUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      isMyPublication: true,
    });

    mockSetMyPublicationUseCase.execute.mockResolvedValueOnce({
      id: validUuid,
      isMyPublication: false,
    });
    const unmarked = await controller.unmarkMyPublication(validUuid, 'user-1');
    expect(unmarked.success).toBe(true);
    expect(mockSetMyPublicationUseCase.execute).toHaveBeenCalledWith({
      userId: 'user-1',
      itemId: validUuid,
      isMyPublication: false,
    });
  });
});
