import { ReaderBootstrapService } from '@/modules/library/catalog/services/reader-bootstrap.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/item-relations.service';

describe('ReaderBootstrapService (Document-Scoped BFF Bootstrap)', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
  const ITEM_ID = '33333333-3333-4333-8333-333333333333';
  const ATT_PRIMARY_ID = '44444444-4444-4444-8444-444444444444';
  const ATT_SECONDARY_ID = '55555555-5555-4555-8555-555555555555';

  let service: ReaderBootstrapService;
  let mockItemQueryService: {
    getItem: jest.Mock;
    getPermissions: jest.Mock;
  };
  let mockFulltextService: {
    getFulltext: jest.Mock;
  };

  const createMockItem = () => ({
    id: ITEM_ID,
    title: 'Attention Is All You Need',
    itemType: 'journalArticle',
    readStatus: 'reading',
    isStarred: true,
    rating: 5,
    currentPage: 7,
    lastReadPage: 7,
    scrollPosition: { y: 420 },
    lastReadAt: '2026-11-05T12:00:00.000Z',
    lastOpenedAt: '2026-11-05T12:30:00.000Z',
    primaryFile: {
      attachmentId: ATT_PRIMARY_ID,
      fileId: 'file-primary',
      filename: 'paper.pdf',
    },
    attachments: [
      {
        id: ATT_PRIMARY_ID,
        attachmentType: 'primary_pdf',
        mimeType: 'application/pdf',
        fileId: 'file-primary',
        annotations: [
          {
            id: 'ann-1',
            quoteText: 'Transformer architecture',
            rectCoords: [10, 20, 110, 50],
          },
          {
            id: 'ann-2',
            text: 'Self-attention mechanism',
            rects: [{ x: 15, y: 30, width: 80, height: 20 }],
          },
        ],
      },
      {
        id: ATT_SECONDARY_ID,
        attachmentType: 'supplementary',
        mimeType: 'application/pdf',
        fileId: 'file-supp',
        annotations: [
          {
            id: 'ann-supp-1',
            quoteText: 'Appendix proof',
            rects: [[5, 10, 55, 30]],
          },
        ],
      },
    ],
    relations: [
      {
        id: 'rel-item-1',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        relationType: 'cites',
        direction: 'outgoing',
      },
    ],
    notes: [
      {
        id: 'note-1',
        title: 'Key takeaway',
        content: 'Replaces recurrence with multi-head attention.',
      },
    ],
  });

  beforeEach(() => {
    mockItemQueryService = {
      getItem: jest.fn().mockResolvedValue(createMockItem()),
      getPermissions: jest.fn().mockResolvedValue({
        role: 'editor',
        permissions: {
          canRead: true,
          canCreateItem: true,
          canEditItem: true,
          canDeleteItem: false,
          canPurgeItem: false,
          canManageCollections: true,
          canImport: true,
          canExport: true,
          canAnnotate: true,
        },
      }),
    };

    mockFulltextService = {
      getFulltext: jest.fn().mockResolvedValue({
        status: 'completed',
        outline: [{ title: '1 Introduction', page: 1 }],
      }),
    };

    service = new ReaderBootstrapService(
      mockItemQueryService as unknown as ItemQueryService,
      mockFulltextService as unknown as ItemFulltextService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('hydrates item, activeAttachmentId, normalized annotations, readingState, relations, notes, fulltext, and permissions in 1 RTT', async () => {
    const res = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
      projectId: PROJECT_ID,
    });

    expect(res).not.toBeNull();
    expect(res?.scope).toBe('project');
    expect(res?.scopeId).toBe(PROJECT_ID);
    expect(res?.degraded).toBeUndefined();
    expect(res?.activeAttachmentId).toBe(ATT_PRIMARY_ID);

    // Verify normalized annotations for the active attachment
    expect(res?.annotations).toHaveLength(2);
    expect(res?.annotations[0]).toMatchObject({
      id: 'ann-1',
      text: 'Transformer architecture',
      quoteText: 'Transformer architecture',
      rects: [{ x1: 10, y1: 20, x2: 110, y2: 50, width: 100, height: 30 }],
    });
    expect(res?.annotations[1]).toMatchObject({
      id: 'ann-2',
      text: 'Self-attention mechanism',
      quoteText: 'Self-attention mechanism',
      rects: [{ x1: 15, y1: 30, x2: 95, y2: 50, width: 80, height: 20 }],
    });

    // Verify readingState is extracted and attached to both root and item
    expect(res?.readingState).toEqual({
      readStatus: 'reading',
      isStarred: true,
      rating: 5,
      currentPage: 7,
      lastReadPage: 7,
      scrollPosition: { y: 420 },
      lastReadAt: '2026-11-05T12:00:00.000Z',
      lastOpenedAt: '2026-11-05T12:30:00.000Z',
    });
    expect((res?.item as Record<string, unknown>)?.readingState).toEqual(
      res?.readingState,
    );

    // Verify zero-SQL extracted relations & notes
    expect(res?.relations).toHaveLength(1);
    expect(res?.notes).toHaveLength(1);
    expect(res?.fulltext).toEqual({
      status: 'completed',
      outline: [{ title: '1 Introduction', page: 1 }],
    });
    expect(res?.role).toBe('editor');
    expect(res?.permissions?.canEditItem).toBe(true);
    expect(res?.permissions?.canAnnotate).toBe(true);
  });

  it('selects explicit attachmentId when requested and returns its normalized annotations', async () => {
    const res = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
      attachmentId: ATT_SECONDARY_ID,
    });

    expect(res?.scope).toBe('user');
    expect(res?.scopeId).toBe(USER_ID);
    expect(res?.activeAttachmentId).toBe(ATT_SECONDARY_ID);
    expect(res?.annotations).toHaveLength(1);
    expect(res?.annotations[0]).toMatchObject({
      id: 'ann-supp-1',
      text: 'Appendix proof',
      quoteText: 'Appendix proof',
      rects: [{ x1: 5, y1: 10, x2: 55, y2: 30, width: 50, height: 20 }],
    });
  });

  it('returns null when the core item does not exist', async () => {
    mockItemQueryService.getItem.mockResolvedValueOnce(null);

    const res = await service.getReaderBootstrap(USER_ID, 'non-existent-id');
    expect(res).toBeNull();
  });

  it('gracefully degrades soft-fail branches (fulltext & permissions) on error or timeout without failing the document bootstrap', async () => {
    mockFulltextService.getFulltext.mockRejectedValueOnce(
      new Error('MinIO S3 connection reset'),
    );
    mockItemQueryService.getPermissions.mockRejectedValueOnce(
      new Error('Permission service timeout'),
    );

    const res = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
      projectId: PROJECT_ID,
    });

    expect(res).not.toBeNull();
    expect(res?.degraded).toBe(true);
    expect(res?.degradedBranches).toEqual(['fulltext', 'permissions']);
    expect(res?.item.id).toBe(ITEM_ID);
    expect(res?.activeAttachmentId).toBe(ATT_PRIMARY_ID);
    expect(res?.annotations).toHaveLength(2);
    expect(res?.fulltext).toBeNull();
    expect(res?.permissions).toBeUndefined();
  });

  it('coalesces concurrent identical bootstrap calls via SingleFlightCoalescer', async () => {
    const [r1, r2, r3] = await Promise.all([
      service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
      service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
      service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
    ]);

    expect(mockItemQueryService.getItem).toHaveBeenCalledTimes(1);
    expect(mockFulltextService.getFulltext).toHaveBeenCalledTimes(1);
    expect(mockItemQueryService.getPermissions).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});
