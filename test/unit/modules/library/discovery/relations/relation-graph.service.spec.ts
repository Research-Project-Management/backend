import { RelationsService as RelationGraphService } from '@/modules/library/relations/relations.service';

import { ItemsRepository as CatalogRepository } from '@/modules/library/items/items.repository';
import { BadRequestException } from '@nestjs/common';

describe('Phase 8: Citation & Relation Graph Subsystem', () => {
  let service: RelationGraphService;
  let mockPaperRepo: any;

  const paperA: any = {
    id: 'paper-a',
    workspaceId: 'ws-1',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, A.', 'Shazeer, N.'],
    year: 2017,
    extra: JSON.stringify({
      relations: [
        {
          targetPaperId: 'paper-b',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
  };

  const paperB: any = {
    id: 'paper-b',
    workspaceId: 'ws-1',
    title: 'BERT Language Model',
    authors: ['Devlin, J.', 'Chang, M.'],
    year: 2018,
    extra: JSON.stringify({
      relations: [
        {
          targetPaperId: 'paper-a',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
  };

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      resolveWorkspaceId: jest.fn().mockResolvedValue('ws-1'),
      findItemById: jest.fn(),
      findItemByIdInWorkspace: jest.fn().mockImplementation((wsId, paperId) => {
        return paperId === 'paper-a' || paperId === 'p1' ? paperA : paperB;
      }),
      findItems: jest.fn(),
      updatePaper: jest.fn(),
      mutatePaperExtra: jest
        .fn()
        .mockImplementation(async (paperId, mutator) => {
          const p = paperId === 'paper-a' || paperId === 'p1' ? paperA : paperB;
          const extraObj = p.extra ? JSON.parse(p.extra) : {};
          const updated = await mutator(extraObj);
          return {
            paper: { ...p, extra: JSON.stringify(updated) },
            extraObj: updated,
          };
        }),
      getRelations: jest.fn().mockResolvedValue([]),
      getBulkRelations: jest.fn().mockResolvedValue(new Map()),
      putRelation: jest.fn().mockResolvedValue(undefined),
      removeRelation: jest.fn().mockResolvedValue(undefined),
    };

    service = new RelationGraphService(mockPaperRepo);
  });

  describe('Symmetric Paper Linking & Validation', () => {
    it('should retrieve related papers for a given paper', async () => {
      mockPaperRepo.findItemById.mockResolvedValue(paperA);
      mockPaperRepo.getRelations.mockResolvedValueOnce([
        {
          targetPaperId: 'paper-b',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      mockPaperRepo.findItems.mockResolvedValue([paperB]);

      const res = await service.getRelatedItems('ws-1', 'paper-a');

      expect(res.total).toBe(1);
      expect(res.relatedItems[0].id).toBe('paper-b');
      expect(res.relatedItems[0].title).toBe('BERT Language Model');
      expect(res.relatedItems[0].relationType).toBe('extends');
    });

    it('should reject linking a paper to itself with BadRequestException', async () => {
      await expect(
        service.linkItems('ws-1', 'paper-a', {
          targetItemId: 'paper-a',
          relationType: 'related' as const,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create symmetric bi-directional links between two papers without losing annotations', async () => {
      mockPaperRepo.findItemById
        .mockResolvedValueOnce(paperA)
        .mockResolvedValueOnce(paperB);

      const res = await service.linkItems('ws-1', 'paper-a', {
        targetItemId: 'paper-b',
        relationType: 'uses_dataset',
        note: 'Shared GLUE benchmark',
      });

      expect(res.success).toBe(true);
      expect(res.link.type).toBe('uses_dataset');
      expect(mockPaperRepo.putRelation).toHaveBeenCalledTimes(2);
    });

    it('should unlink symmetric relations on both papers', async () => {
      mockPaperRepo.findItemById
        .mockResolvedValueOnce(paperA)
        .mockResolvedValueOnce(paperB);

      const res = await service.unlinkItems('ws-1', 'paper-a', 'paper-b');

      expect(res.success).toBe(true);
      expect(mockPaperRepo.removeRelation).toHaveBeenCalledTimes(2);
    });
  });

  describe('Legacy directed relation compatibility', () => {
    it('stores a directed relation only on the source item', async () => {
      mockPaperRepo.findItemById
        .mockResolvedValueOnce(paperA)
        .mockResolvedValueOnce(paperB);

      mockPaperRepo.getRelations.mockResolvedValueOnce([]);

      const result = await service.linkDirectedItems(
        'ws-1',
        'paper-a',
        {
          targetItemId: 'paper-b',
          relationType: 'extends',
          description: 'Directional compatibility route',
        },
        'user-1',
      );

      expect(result.relation.targetItemId).toBe('paper-b');
      expect(mockPaperRepo.putRelation).toHaveBeenCalledTimes(1);
      expect(mockPaperRepo.putRelation).toHaveBeenCalledWith(
        'paper-a',
        expect.objectContaining({ targetItemId: 'paper-b', type: 'extends' }),
      );
    });

    it('removes only the source-side directed relation', async () => {
      mockPaperRepo.findItemById.mockResolvedValueOnce(paperA);

      mockPaperRepo.getRelations.mockResolvedValueOnce([
        { targetItemId: 'paper-b', type: 'extends' },
      ]);

      const result = await service.unlinkDirectedItems(
        'ws-1',
        'paper-a',
        'paper-b',
        'extends',
      );

      expect(result.unlinked).toBe(true);
      expect(mockPaperRepo.removeRelation).toHaveBeenCalledTimes(1);
      expect(mockPaperRepo.removeRelation).toHaveBeenCalledWith(
        'paper-a',
        'paper-b',
      );
    });
  });

  describe('Workspace Knowledge Graph Extraction', () => {
    it('should construct the workspace knowledge graph with unique undirected edges', async () => {
      mockPaperRepo.findItems.mockResolvedValue([paperA, paperB]);
      mockPaperRepo.getBulkRelations.mockResolvedValueOnce(
        new Map([
          [
            'paper-a',
            [
              {
                targetPaperId: 'paper-b',
                type: 'extends',
                note: 'link',
                linkedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          ],
          [
            'paper-b',
            [
              {
                targetPaperId: 'paper-a',
                type: 'extends',
                note: 'link',
                linkedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          ],
        ]),
      );

      const graph = await service.getWorkspaceRelationGraph('ws-1');

      expect(graph.totalNodes).toBe(2);
      expect(graph.totalEdges).toBe(1);
      expect(graph.edges[0].source).toBe('paper-a');
      expect(graph.edges[0].target).toBe('paper-b');
      expect(graph.edges[0].relationType).toBe('extends');
    });
  });
});
