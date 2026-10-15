import { IngestionService } from '@/modules/library/ingestion/services/ingestion.service';
import { IngestionRepository } from '@/modules/library/ingestion/repositories/ingestion.repository';
import { PipelineService } from '@/modules/library/ingestion/services/pipeline.service';
import { QueueService } from '@/modules/library/ingestion/services/queue.service';
import { UrlCaptureService } from '@/modules/library/ingestion/services/url-capture.service';
import { ICatalogGatewayPort } from '@/modules/library/ingestion/types/catalog-gateway.types';
import { ItemDetail } from '@/modules/library/catalog/types/items.types';
import {
  MetadataPort,
  ResolvedMetadata,
} from '@/modules/library/ingestion/types/metadata.types';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('IngestionService - reResolveMetadata', () => {
  let ingestionService: IngestionService;
  let mockCatalogGateway: jest.Mocked<ICatalogGatewayPort>;
  let mockMetadataService: jest.Mocked<MetadataPort>;

  const mockRepo = {} as unknown as IngestionRepository;
  const mockPipeline = {} as unknown as PipelineService;
  const mockQueue = {} as unknown as QueueService;
  const mockUrlCapture = {} as unknown as UrlCaptureService;

  const createMockItem = (
    overrides: Partial<ItemDetail> & {
      id: string;
      title: string;
      version: number;
    },
  ): ItemDetail => ({
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    mockCatalogGateway = {
      getItem: jest.fn(),
      updateItem: jest.fn(),
      createItem: jest.fn(),
      deleteItem: jest.fn(),
      findDuplicateCandidateItems: jest.fn(),
      findByIds: jest.fn(),
      mergeItems: jest.fn(),
      findQualityAuditItems: jest.fn(),
    };

    mockMetadataService = {
      resolve: jest.fn(),
    };

    ingestionService = new IngestionService(
      mockRepo,
      mockPipeline,
      mockQueue,
      mockUrlCapture,
      mockCatalogGateway,
      undefined,
      mockMetadataService,
    );
  });

  it('throws NotFoundException when item does not exist in catalog', async () => {
    mockCatalogGateway.getItem.mockResolvedValue(null);

    await expect(
      ingestionService.reResolveMetadata('user-1', 'item-missing', {
        doi: '10.1038/nature12345',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when neither DTO nor item provides a query identifier or credible title', async () => {
    mockCatalogGateway.getItem.mockResolvedValue(
      createMockItem({
        id: 'item-1',
        title: 'Uploaded Document', // Generic title
        version: 1,
      }),
    );

    await expect(
      ingestionService.reResolveMetadata('user-1', 'item-1', {}),
    ).rejects.toThrow(BadRequestException);
  });

  it('successfully re-resolves metadata using existing item DOI and updates catalog', async () => {
    const existingItem = createMockItem({
      id: 'item-123',
      title: 'Draft manuscript',
      doi: '10.1038/s41586-021-03819-2',
      version: 2,
    });
    mockCatalogGateway.getItem.mockResolvedValue(existingItem);

    const resolved: ResolvedMetadata = {
      query: '10.1038/s41586-021-03819-2',
      queryType: 'DOI',
      canonicalId: '10.1038/s41586-021-03819-2',
      metadata: {
        title: 'Highly accurate protein structure prediction with AlphaFold',
        authors: ['John Jumper', 'Richard Evans', 'Alexander Pritzel'],
        year: 2021,
        journal: 'Nature',
        publisher: 'Nature Publishing Group',
        volume: '596',
        pages: '583–589',
        doi: '10.1038/s41586-021-03819-2',
        abstract:
          'Proteins are essential to life, and understanding their structure can facilitate a mechanistic understanding.',
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
      policyVersion: 1,
    };
    mockMetadataService.resolve.mockResolvedValue(resolved);

    const updatedItem = {
      ...existingItem,
      title: resolved.metadata.title || existingItem.title,
      version: 3,
    };
    mockCatalogGateway.updateItem.mockResolvedValue(updatedItem);

    const result = await ingestionService.reResolveMetadata(
      'user-1',
      'item-123',
    );

    expect(result.success).toBe(true);
    expect(result.itemId).toBe('item-123');
    expect(result.updatedFields).toContain('title');
    expect(result.updatedFields).toContain('creators');
    expect(result.updatedFields).toContain('publicationTitle');
    expect(result.updatedFields).toContain('publisher');
    expect(result.updatedFields).toContain('abstractNote');

    expect(mockCatalogGateway.updateItem).toHaveBeenCalledWith(
      'user-1',
      'item-123',
      expect.objectContaining({
        title: 'Highly accurate protein structure prediction with AlphaFold',
        publicationTitle: 'Nature',
        publisher: 'Nature Publishing Group',
        abstractNote: expect.stringContaining('Proteins are essential to life'),
      }),
      2, // expectedVersion
      undefined,
    );
  });

  it('correctly parses Vietnamese author names during re-resolution', async () => {
    const existingItem = createMockItem({
      id: 'item-vn-1',
      title: 'Phát hiện bệnh cây trồng',
      doi: '10.1016/j.cropro.2023.10001',
      version: 1,
    });
    mockCatalogGateway.getItem.mockResolvedValue(existingItem);

    const resolved: ResolvedMetadata = {
      query: '10.1016/j.cropro.2023.10001',
      queryType: 'DOI',
      canonicalId: '10.1016/j.cropro.2023.10001',
      metadata: {
        title: 'Deep Learning for Crop Protection in Vietnam',
        authors: ['Nguyễn Văn An', 'Trần Thị Mai'],
        year: 2023,
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
      policyVersion: 1,
    };
    mockMetadataService.resolve.mockResolvedValue(resolved);
    mockCatalogGateway.updateItem.mockResolvedValue({
      ...existingItem,
      version: 2,
    });

    const result = await ingestionService.reResolveMetadata(
      'user-1',
      'item-vn-1',
    );

    expect(result.success).toBe(true);
    expect(mockCatalogGateway.updateItem).toHaveBeenCalledWith(
      'user-1',
      'item-vn-1',
      expect.objectContaining({
        creators: [
          expect.objectContaining({
            firstName: 'Văn An',
            lastName: 'Nguyễn',
            fullName: 'Nguyễn Văn An',
          }),
          expect.objectContaining({
            firstName: 'Thị Mai',
            lastName: 'Trần',
            fullName: 'Trần Thị Mai',
          }),
        ],
      }),
      1,
      undefined,
    );
  });

  it('returns up-to-date message when no fields are modified', async () => {
    const existingItem = createMockItem({
      id: 'item-clean',
      title: 'Exact Same Title',
      doi: '10.1145/12345',
      version: 1,
    });
    mockCatalogGateway.getItem.mockResolvedValue(existingItem);

    const resolved: ResolvedMetadata = {
      query: '10.1145/12345',
      queryType: 'DOI',
      canonicalId: '10.1145/12345',
      metadata: {
        title: 'Exact Same Title',
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
      policyVersion: 1,
    };
    mockMetadataService.resolve.mockResolvedValue(resolved);

    const result = await ingestionService.reResolveMetadata(
      'user-1',
      'item-clean',
    );

    expect(result.success).toBe(true);
    expect(result.updatedFields).toHaveLength(0);
    expect(result.message).toContain('already up to date');
    expect(mockCatalogGateway.updateItem).not.toHaveBeenCalled();
  });
});
