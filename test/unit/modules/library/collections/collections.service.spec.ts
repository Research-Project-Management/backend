import { Test, TestingModule } from '@nestjs/testing';
import { CollectionsService } from '@/modules/library/collections/collections.service';
import { CollectionsRepository } from '@/modules/library/collections/collections.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { BibtexFormatter } from '@/modules/library/citation/formatters/bibtex.formatter';

describe('CollectionsService', () => {
  let service: CollectionsService;
  let repo: CollectionsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionsService,
        BibtexFormatter,
        {
          provide: CollectionsRepository,
          useValue: {
            prisma: {
              paper: {
                findMany: jest.fn(),
              },
            },
            resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
            findWorkspaceCollections: jest.fn(),
            findCollectionById: jest.fn(),
            createCollection: jest.fn(),
            updateCollection: jest.fn(),
            deleteCollection: jest.fn(),
            reparentChildren: jest.fn(),
            movePapers: jest.fn(),
            findPapersInCollection: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<CollectionsService>(CollectionsService);
    repo = module.get<CollectionsRepository>(CollectionsRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should create collection successfully with slug resolution', async () => {
    (repo.createCollection as jest.Mock).mockResolvedValue({
      id: 'c-1',
      name: 'AI Papers',
      workspaceId: 'ws-1',
    });

    const result = await service.createCollection('ai-ai', 'user-1', {
      name: 'AI Papers',
    });

    expect(result.collection.name).toBe('AI Papers');
    expect(result.collection.id).toBe('c-1');
  });

  it('should prevent setting collection as its own parent', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-1',
      name: 'AI Papers',
      workspaceId: 'ws-1',
      parentId: null,
    });

    await expect(
      service.updateCollection('c-1', { parentId: 'c-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should prevent circular parent-child hierarchy (A -> B -> A)', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-1',
      name: 'AI',
      workspaceId: 'ws-1',
      parentId: null,
    });

    (repo.findWorkspaceCollections as jest.Mock).mockResolvedValue([
      { id: 'c-1', parentId: null },
      { id: 'c-2', parentId: 'c-1' }, // c-2 is child of c-1
    ]);

    // Trying to make c-1 child of c-2 (creating cycle c-1 -> c-2 -> c-1)
    await expect(
      service.updateCollection('c-1', { parentId: 'c-2' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should support move-to-parent delete strategy', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-2',
      name: 'Child Collection',
      workspaceId: 'ws-1',
      parentId: 'c-1',
    });
    (repo.reparentChildren as jest.Mock).mockResolvedValue({ count: 2 });
    (repo.deleteCollection as jest.Mock).mockResolvedValue({});

    const res = await service.deleteCollection('c-2', 'move-to-parent');
    expect(repo.reparentChildren).toHaveBeenCalledWith('c-2', 'c-1');
    expect(repo.deleteCollection).toHaveBeenCalledWith('c-2');
    expect(res.message).toContain('successfully');
  });

  it('should bulk move papers between collections', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-target',
      workspaceId: 'ws-1',
    });
    (repo.movePapers as jest.Mock).mockResolvedValue({ count: 3 });

    const res = await service.movePapers('ws-1', 'c-target', [
      'p-1',
      'p-2',
      'p-3',
    ]);
    expect(res.count).toBe(3);
    expect(res.targetCollectionId).toBe('c-target');
  });

  it('should assign papers to a collection (Playlist assignment)', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-1',
      workspaceId: 'ws-1',
    });
    (repo.movePapers as jest.Mock).mockResolvedValue({ count: 2 });

    const res = await service.assignPapersToCollection('ws-1', 'c-1', {
      paperIds: ['p-1', 'p-2'],
    });

    expect(res.message).toContain('successfully');
    expect(res.count).toBe(2);
    expect(repo.movePapers).toHaveBeenCalledWith('ws-1', 'c-1', ['p-1', 'p-2']);
  });

  it('should soft-detach paper from collection without deleting paper record', async () => {
    (repo.movePapers as jest.Mock).mockResolvedValue({ count: 1 });

    const res = await service.detachPaperFromCollection('ws-1', 'c-1', 'p-1');
    expect(res.message).toContain('successfully');
    expect(repo.movePapers).toHaveBeenCalledWith('ws-1', null, ['p-1']);
  });

  it('should export all papers in collection as formatted BibTeX', async () => {
    (repo.findCollectionById as jest.Mock).mockResolvedValue({
      id: 'c-1',
      workspaceId: 'ws-1',
    });
    (repo.findPapersInCollection as jest.Mock).mockResolvedValue([
      {
        title: 'Attention Is All You Need',
        authors: ['Vaswani, Ashish'],
        year: 2017,
        citationKey: 'vaswani2017attention',
        doi: '10.5555/3295222.3295349',
        journal: 'NeurIPS',
        abstract: '',
      },
    ]);

    const res = await service.exportCollectionBibtex('ws-1', 'c-1');
    expect(res.total).toBe(1);
    expect(res.filename).toBe('collection-c-1.bib');
    expect(res.bibtex).toContain('@article{vaswani2017attention,');
  });
});
