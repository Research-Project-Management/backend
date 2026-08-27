import { Test, TestingModule } from '@nestjs/testing';
import { ReportService as LibraryReportService } from '@/modules/library/legacy/report/report.service';
import { ItemsRepository as CatalogRepository } from '@/modules/library/legacy/items/items.repository';
import { NotFoundException } from '@nestjs/common';

describe('LibraryReportService', () => {
  let service: LibraryReportService;
  let catalogRepo: jest.Mocked<CatalogRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LibraryReportService,
        {
          provide: CatalogRepository,
          useValue: {
            resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
            findItemByIdInWorkspace: jest.fn(),
            findCollectionById: jest.fn(),
            findItems: jest.fn(),
            getAnnotations: jest.fn().mockResolvedValue([]),
            getRelations: jest.fn().mockResolvedValue([]),
            getBulkAnnotations: jest.fn().mockResolvedValue(new Map()),
            getBulkRelations: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();

    service = module.get<LibraryReportService>(LibraryReportService);
    catalogRepo = module.get(CatalogRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should generate collection report in batch without N+1 query loop', async () => {
    catalogRepo.findCollectionById.mockResolvedValue({
      id: 'col-1',
      name: 'Deep Learning',
      workspaceId: 'ws-1',
    } as any);

    catalogRepo.findItems.mockResolvedValue([
      {
        id: 'p-1',
        title: 'Attention is All You Need',
        abstract: 'Transformers intro',
        labels: ['ai', 'transformers'],
        notes: [],
        attachments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
      {
        id: 'p-2',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        abstract: 'Language representation',
        labels: ['nlp'],
        notes: [],
        attachments: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any,
    ]);

    const annotationsMap = new Map();
    annotationsMap.set('p-1', [{ id: 'ann-1', color: '#ff0' }]);
    annotationsMap.set('p-2', []);

    const relationsMap = new Map();
    relationsMap.set('p-1', [{ targetPaperId: 'p-2' }]);
    relationsMap.set('p-2', []);

    catalogRepo.getBulkAnnotations.mockResolvedValue(annotationsMap);
    catalogRepo.getBulkRelations.mockResolvedValue(relationsMap);

    const report = await service.getCollectionReport('ws-1', 'col-1');

    expect(report.totalItems).toBe(2);
    expect(report.collection.name).toBe('Deep Learning');
    expect(report.items[0].title).toBe('Attention is All You Need');
    expect(report.items[0].annotations.length).toBe(1);
    expect(report.items[0].relatedCount).toBe(1);

    // Verify batch calls were made once with all itemIds
    expect(catalogRepo.getBulkAnnotations).toHaveBeenCalledWith(['p-1', 'p-2']);
    expect(catalogRepo.getBulkRelations).toHaveBeenCalledWith(['p-1', 'p-2']);
    // Verify per-item loops were not invoked
    expect(catalogRepo.getAnnotations).not.toHaveBeenCalled();
    expect(catalogRepo.getRelations).not.toHaveBeenCalled();
  });

  it('should throw NotFoundException if collection not found in workspace', async () => {
    catalogRepo.findCollectionById.mockResolvedValue(null);

    await expect(
      service.getCollectionReport('ws-1', 'col-non-existent'),
    ).rejects.toThrow(NotFoundException);
  });
});
