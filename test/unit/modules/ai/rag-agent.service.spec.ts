import { RagAgentService } from '@/modules/ai/rag-agent/rag-agent.service';
import { EngineService } from '@/modules/ai/engine/engine.service';

describe('RagAgentService (Paper-Scoped AI Copilot)', () => {
  let service: RagAgentService;
  let mockEngine: jest.Mocked<EngineService>;
  let mockPaperRepo: any;

  beforeEach(() => {
    mockEngine = {
      streamChat: jest.fn().mockResolvedValue(undefined),
      syncChat: jest.fn().mockResolvedValue({
        answer: 'The attention mechanism relies on scaled dot-product.',
        citations: [{ pageNumber: 3, section: '3.2' }],
      }),
    } as any;

    mockPaperRepo = {
      findItemById: jest.fn(),
      findById: jest.fn(),
    };

    service = new RagAgentService(mockEngine, mockPaperRepo);
  });

  it('should enrich chat payload with paper metadata and execute streamChat', async () => {
    const mockPaper = {
      id: 'paper-vaswani',
      workspaceId: 'ws-ai-lab',
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish'],
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
      abstract: 'We propose a simple network architecture, the Transformer...',
      ragDocId: 'rag-doc-999',
      deletedAt: null,
    };

    mockPaperRepo.findItemById.mockResolvedValueOnce(mockPaper);

    const mockReply = {} as any;
    const dto = {
      query: 'What is Multi-Head Attention?',
      workspace_id: 'ws-ai-lab',
    };

    await service.streamPaperChat('user-1', 'paper-vaswani', dto, mockReply);

    expect(mockPaperRepo.findItemById).toHaveBeenCalledWith('paper-vaswani');
    expect(mockEngine.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        document_ids: ['rag-doc-999'],
        intent_hint: 'paper_rag_qa',
        workspace_id: 'ws-ai-lab',
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('Attention Is All You Need'),
          }),
          expect.objectContaining({
            role: 'user',
            content: 'What is Multi-Head Attention?',
          }),
        ]),
      }),
      mockReply,
    );
  });

  it('should execute synchronous paper-scoped RAG query', async () => {
    const mockPaper = {
      id: 'paper-resnet',
      workspaceId: 'ws-ai-lab',
      title: 'Deep Residual Learning',
      authors: ['He, Kaiming'],
      year: 2016,
      ragDocId: 'rag-resnet-1',
      deletedAt: null,
    };

    mockPaperRepo.findItemById.mockResolvedValueOnce(mockPaper);

    const dto = {
      query: 'Explain residual connection benefit',
    };

    const res = await service.syncPaperChat('user-1', 'paper-resnet', dto);

    expect(res).toBeDefined();
    expect(res.answer).toContain('scaled dot-product');
    expect(mockEngine.syncChat).toHaveBeenCalled();
  });
});
