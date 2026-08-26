import { backfillLibraryMetadata } from '../../../../../scripts/backfill-library-metadata';

describe('backfillLibraryMetadata (Phase 2 Data Backfill)', () => {
  let mockPrisma: any;

  const mockItem = {
    id: 'item-101',
    workspaceId: 'ws-1',
    uploadedById: 'user-1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
    editors: ['Bengio, Yoshua'],
    year: 2017,
    doi: '10.5555/3295222.3295349',
    pmid: '29124373',
    isbn: null,
    issn: null,
    collectionId: 'col-1',
    labels: ['NLP', 'Deep Learning'],
    itemType: 'conferencePaper',
    journal: 'NeurIPS',
    citationKey: 'vaswani2017attention',
    createdAt: new Date(),
  };

  beforeEach(() => {
    mockPrisma = {
      catalogItem: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([mockItem])
          .mockResolvedValueOnce([]),
      },
      catalogContributor: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'contrib-1' }),
      },
      catalogIdentifier: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ident-1' }),
      },
      collectionItem: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'col-item-1' }),
      },
      catalogTag: {
        upsert: jest.fn().mockResolvedValue({ id: 'tag-1', name: 'NLP' }),
      },
      catalogItemTag: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'item-tag-1' }),
      },
      catalogItemRevision: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'rev-1', version: 1 }),
      },
      $transaction: jest.fn(async (cb) => await cb(mockPrisma)),
    };
  });

  it('backfills contributors, identifiers, collection items, tags, and revision idempotently', async () => {
    const count = await backfillLibraryMetadata(mockPrisma);

    expect(count).toBe(1);

    // Contributor creations (2 authors + 1 editor = 3)
    expect(mockPrisma.catalogContributor.create).toHaveBeenCalledTimes(3);
    expect(mockPrisma.catalogContributor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogItemId: 'item-101',
        creatorType: 'author',
        fullName: 'Vaswani, Ashish',
        lastName: 'vaswani',
      }),
    });

    // Identifiers creations (DOI + PMID = 2)
    expect(mockPrisma.catalogIdentifier.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.catalogIdentifier.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogItemId: 'item-101',
        type: 'DOI',
        value: '10.5555/3295222.3295349',
        canonicalUri: 'doi:10.5555/3295222.3295349',
      }),
    });

    // Collection Item creation (1)
    expect(mockPrisma.collectionItem.create).toHaveBeenCalledWith({
      data: {
        collectionId: 'col-1',
        catalogItemId: 'item-101',
        sortOrder: 0,
      },
    });

    // Tag creations (2)
    expect(mockPrisma.catalogTag.upsert).toHaveBeenCalledTimes(2);
    expect(mockPrisma.catalogItemTag.create).toHaveBeenCalledTimes(2);

    // Initial revision snapshot
    expect(mockPrisma.catalogItemRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        catalogItemId: 'item-101',
        version: 1,
        changedById: 'user-1',
      }),
    });
  });

  it('skips creating existing relations on re-run (idempotency guarantee)', async () => {
    mockPrisma.catalogContributor.findFirst.mockResolvedValue({
      id: 'existing',
    });
    mockPrisma.catalogIdentifier.findFirst.mockResolvedValue({
      id: 'existing',
    });
    mockPrisma.collectionItem.findUnique.mockResolvedValue({ id: 'existing' });
    mockPrisma.catalogItemTag.findUnique.mockResolvedValue({ id: 'existing' });
    mockPrisma.catalogItemRevision.findFirst.mockResolvedValue({
      id: 'existing',
    });

    const count = await backfillLibraryMetadata(mockPrisma);

    expect(count).toBe(1);
    expect(mockPrisma.catalogContributor.create).not.toHaveBeenCalled();
    expect(mockPrisma.catalogIdentifier.create).not.toHaveBeenCalled();
    expect(mockPrisma.collectionItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.catalogItemTag.create).not.toHaveBeenCalled();
    expect(mockPrisma.catalogItemRevision.create).not.toHaveBeenCalled();
  });
});
