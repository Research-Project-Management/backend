import { RagAgentService } from '@/modules/ai/rag-agent/rag-agent.service';
import { EngineService } from '@/modules/ai/engine/engine.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('RagAgentService (Paper-Scoped AI Copilot & Tenant Isolation)', () => {
  let service: RagAgentService;
  let mockEngine: jest.Mocked<EngineService>;
  let mockCatalogService: any;

  beforeEach(() => {
    mockEngine = {
      streamChat: jest.fn().mockResolvedValue(undefined),
      syncChat: jest.fn().mockResolvedValue({
        answer: 'The attention mechanism relies on scaled dot-product.',
        citations: [{ pageNumber: 3, section: '3.2' }],
      }),
    } as any;

    mockCatalogService = {
      getItem: jest.fn(),
    };

    service = new RagAgentService(mockEngine, mockCatalogService);
  });

  it('should enrich chat payload with paper metadata and execute streamChat within authorized workspace', async () => {
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

    mockCatalogService.getItem.mockResolvedValueOnce(mockPaper);

    const mockReply = {} as any;
    const dto = {
      query: 'What is Multi-Head Attention?',
      workspaceId: 'ws-ai-lab',
    };

    await service.streamPaperChat('user-1', 'paper-vaswani', dto, mockReply);

    expect(mockCatalogService.getItem).toHaveBeenCalledWith(
      'ws-ai-lab',
      'paper-vaswani',
      'user-1',
    );
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

  it('should reject request when workspaceId is missing', async () => {
    const dto = {
      query: 'What is attention?',
    };

    await expect(
      service.streamPaperChat('user-1', 'paper-1', dto, {} as any),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.syncPaperChat('user-1', 'paper-1', dto),
    ).rejects.toThrow(BadRequestException);
  });

  it('should throw NotFoundException when paper is not found in the workspace (no leakage)', async () => {
    mockCatalogService.getItem.mockResolvedValueOnce(null);

    const dto = {
      query: 'Explain architecture',
      workspaceId: 'ws-tenant-a',
    };

    await expect(
      service.syncPaperChat('user-1', 'paper-other-tenant', dto),
    ).rejects.toThrow(NotFoundException);

    expect(mockCatalogService.getItem).toHaveBeenCalledWith(
      'ws-tenant-a',
      'paper-other-tenant',
      'user-1',
    );
    expect(mockEngine.syncChat).not.toHaveBeenCalled();
  });

  it('should execute synchronous paper-scoped RAG query with valid workspaceId', async () => {
    const mockPaper = {
      id: 'paper-resnet',
      workspaceId: 'ws-ai-lab',
      title: 'Deep Residual Learning',
      authors: ['He, Kaiming'],
      year: 2016,
      ragDocId: 'rag-resnet-1',
      deletedAt: null,
    };

    mockCatalogService.getItem.mockResolvedValueOnce(mockPaper);

    const dto = {
      query: 'Explain residual connection benefit',
      workspaceId: 'ws-ai-lab',
    };

    const res = await service.syncPaperChat('user-1', 'paper-resnet', dto);

    expect(res).toBeDefined();
    expect(res.answer).toContain('scaled dot-product');
    expect(mockCatalogService.getItem).toHaveBeenCalledWith(
      'ws-ai-lab',
      'paper-resnet',
      'user-1',
    );
    expect(mockEngine.syncChat).toHaveBeenCalled();
  });
});
