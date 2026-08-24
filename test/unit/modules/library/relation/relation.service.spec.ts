import { RelationService } from '@/modules/library/relation/relation.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';
import { BadRequestException } from '@nestjs/common';

describe('Seam 2B: RelationService (Knowledge Graph & Symmetric Paper Relations)', () => {
  let service: RelationService;
  let mockPaperRepo: any;

  const paperA = {
    id: 'paper-a',
    workspaceId: 'ws-1',
    title: 'Transformer Base Paper',
    extra: JSON.stringify({
      annotations: [{ id: 'ann-keep', color: '#ff0' }],
      relations: [
        {
          targetPaperId: 'paper-b',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    deletedAt: null,
  };

  const paperB = {
    id: 'paper-b',
    workspaceId: 'ws-1',
    title: 'BERT Language Model',
    authors: ['Devlin, Jacob'],
    year: 2018,
    citationKey: 'devlin2018bert',
    extra: JSON.stringify({
      annotations: [{ id: 'ann-keep-b', color: '#00f' }],
      relations: [
        {
          targetPaperId: 'paper-a',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }),
    deletedAt: null,
  };

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPaperById: jest.fn(),
      findPapers: jest.fn(),
      updatePaper: jest.fn(),
      mutatePaperExtra: jest.fn().mockImplementation(async (paperId, mutator) => {
        const p = paperId === 'paper-a' || paperId === 'p1' ? paperA : paperB;
        const extraObj = p.extra ? JSON.parse(p.extra) : {};
        const updated = await mutator(extraObj);
        return {
          paper: { ...p, extra: JSON.stringify(updated) },
          extraObj: updated,
        };
      }),
    };

    service = new RelationService(mockPaperRepo);
  });

  describe('Vertical Slice 2.4: Symmetric Paper Linking & Validation', () => {
    it('should retrieve related papers for a given paper', async () => {
      mockPaperRepo.findPaperById.mockResolvedValue(paperA);
      mockPaperRepo.findPapers.mockResolvedValue([paperB]);

      const res = await service.getRelatedPapers('ws-1', 'paper-a');

      expect(res.total).toBe(1);
      expect(res.relatedPapers[0].id).toBe('paper-b');
      expect(res.relatedPapers[0].title).toBe('BERT Language Model');
      expect(res.relatedPapers[0].relationType).toBe('extends');
    });

    it('should reject linking a paper to itself with BadRequestException', async () => {
      await expect(
        service.linkPapers('ws-1', 'paper-a', {
          targetPaperId: 'paper-a',
          relationType: 'related',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create symmetric bi-directional links between two papers without losing annotations', async () => {
      mockPaperRepo.findPaperById
        .mockResolvedValueOnce(paperA)
        .mockResolvedValueOnce(paperB);

      const res = await service.linkPapers('ws-1', 'paper-a', {
        targetPaperId: 'paper-b',
        relationType: 'uses_dataset',
        note: 'Shared GLUE benchmark',
      });

      expect(res.success).toBe(true);
      expect(res.link.type).toBe('uses_dataset');
      expect(mockPaperRepo.mutatePaperExtra).toHaveBeenCalledTimes(2);
    });

    it('should unlink symmetric relations on both papers', async () => {
      mockPaperRepo.findPaperById
        .mockResolvedValueOnce(paperA)
        .mockResolvedValueOnce(paperB);

      const res = await service.unlinkPapers('ws-1', 'paper-a', 'paper-b');

      expect(res.success).toBe(true);
      expect(mockPaperRepo.mutatePaperExtra).toHaveBeenCalledTimes(2);
    });
  });

  describe('Vertical Slice 2.5: Workspace Knowledge Graph Extraction', () => {
    it('should construct the workspace knowledge graph with unique undirected edges', async () => {
      mockPaperRepo.findPapers.mockResolvedValue([paperA, paperB]);

      const graph = await service.getWorkspaceKnowledgeGraph('ws-1');

      expect(graph.totalNodes).toBe(2);
      expect(graph.totalEdges).toBe(1); // 1 undirected edge between paper-a and paper-b
      expect(graph.edges[0].source).toBe('paper-a');
      expect(graph.edges[0].target).toBe('paper-b');
      expect(graph.edges[0].relationType).toBe('extends');
    });
  });
});
