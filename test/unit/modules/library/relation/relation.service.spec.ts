import { RelationService } from '@/modules/library/relation/relation.service';
import { PaperRepository } from '@/modules/library/paper/paper.repository';

describe('RelationService', () => {
  let service: RelationService;
  let mockPaperRepo: any;

  beforeEach(() => {
    mockPaperRepo = {
      resolveWorkspace: jest.fn().mockResolvedValue({ id: 'ws-1' }),
      findPaperById: jest.fn(),
      findPapers: jest.fn(),
      updatePaper: jest.fn(),
    };

    service = new RelationService(mockPaperRepo);
  });

  const paperA = {
    id: 'paper-a',
    workspaceId: 'ws-1',
    title: 'Transformer Base Paper',
    extra: JSON.stringify({
      relations: [
        {
          targetPaperId: 'paper-b',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: new Date().toISOString(),
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
      relations: [
        {
          targetPaperId: 'paper-a',
          type: 'extends',
          note: 'BERT builds on Transformer encoder',
          linkedAt: new Date().toISOString(),
        },
      ],
    }),
    deletedAt: null,
  };

  it('should retrieve related papers for a given paper', async () => {
    mockPaperRepo.findPaperById.mockResolvedValue(paperA);
    mockPaperRepo.findPapers.mockResolvedValue([paperB]);

    const res = await service.getRelatedPapers('ws-1', 'paper-a');

    expect(res.total).toBe(1);
    expect(res.relatedPapers[0].id).toBe('paper-b');
    expect(res.relatedPapers[0].title).toBe('BERT Language Model');
    expect(res.relatedPapers[0].relationType).toBe('extends');
  });

  it('should create symmetric bi-directional links between two papers', async () => {
    const rawPaper1 = { id: 'p1', workspaceId: 'ws-1', extra: '', deletedAt: null };
    const rawPaper2 = { id: 'p2', workspaceId: 'ws-1', extra: '', deletedAt: null };

    mockPaperRepo.findPaperById
      .mockResolvedValueOnce(rawPaper1)
      .mockResolvedValueOnce(rawPaper2);
    mockPaperRepo.updatePaper.mockResolvedValue({});

    const res = await service.linkPapers('ws-1', 'p1', {
      targetPaperId: 'p2',
      relationType: 'uses_dataset',
      note: 'Shared benchmark',
    });

    expect(res.success).toBe(true);
    expect(res.link.type).toBe('uses_dataset');
    expect(mockPaperRepo.updatePaper).toHaveBeenCalledTimes(2);
  });

  it('should construct the workspace knowledge graph with nodes and undirected edges', async () => {
    mockPaperRepo.findPapers.mockResolvedValue([paperA, paperB]);

    const graph = await service.getWorkspaceKnowledgeGraph('ws-1');

    expect(graph.totalNodes).toBe(2);
    expect(graph.totalEdges).toBe(1); // 1 undirected edge between paper-a and paper-b
    expect(graph.edges[0].source).toBe('paper-a');
    expect(graph.edges[0].target).toBe('paper-b');
  });
});
