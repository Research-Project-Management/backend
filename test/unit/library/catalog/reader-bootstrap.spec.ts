import { ReaderBootstrapService } from '@/modules/library/catalog/services/reader-bootstrap.service';
import { LibraryBootstrapService } from '@/modules/library/catalog/services/bootstrap.service';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { ItemFulltextService } from '@/modules/library/catalog/services/relations.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';

describe('ReaderBootstrapService & LibraryBootstrapService (BFF Bootstraps)', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111';
  const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
  const ITEM_ID = '33333333-3333-4333-8333-333333333333';
  const ATT_PRIMARY_ID = '44444444-4444-4444-8444-444444444444';
  const ATT_SECONDARY_ID = '55555555-5555-4555-8555-555555555555';

  describe('ReaderBootstrapService', () => {
    let service: ReaderBootstrapService;
    let mockItemQueryService: { getItem: jest.Mock; getPermissions: jest.Mock };
    let mockFulltextService: { getFulltext: jest.Mock };

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

    it('hydrates item, activeAttachmentId, normalized annotations, readingState, relations, notes, fulltext, and permissions in 1 RTT', async () => {
      const res = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
        projectId: PROJECT_ID,
      });

      expect(res).not.toBeNull();
      expect(res?.scope).toBe('project');
      expect(res?.spaceId).toBe(PROJECT_ID);
      expect(res?.activeAttachmentId).toBe(ATT_PRIMARY_ID);
      expect(res?.annotations).toHaveLength(2);
      expect(res?.annotations[0]).toMatchObject({
        id: 'ann-1',
        quoteText: 'Transformer architecture',
        rects: [{ x1: 10, y1: 20, x2: 110, y2: 50, width: 100, height: 30 }],
      });
      expect(res?.annotations[1]).toMatchObject({
        id: 'ann-2',
        quoteText: 'Self-attention mechanism',
        rects: [{ x1: 15, y1: 30, x2: 95, y2: 50, width: 80, height: 20 }],
      });
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
      expect(res?.relations).toHaveLength(1);
      expect(res?.notes).toHaveLength(1);
      expect(res?.role).toBe('editor');
    });

    it('selects explicit attachmentId, returns null on missing item, degrades soft-fail branches, and coalesces concurrent calls', async () => {
      const explicitRes = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
        attachmentId: ATT_SECONDARY_ID,
      });
      expect(explicitRes?.activeAttachmentId).toBe(ATT_SECONDARY_ID);
      expect(explicitRes?.annotations[0]).toMatchObject({
        id: 'ann-supp-1',
        rects: [{ x1: 5, y1: 10, x2: 55, y2: 30, width: 50, height: 20 }],
      });

      mockItemQueryService.getItem.mockResolvedValueOnce(null);
      expect(
        await service.getReaderBootstrap(USER_ID, 'missing-id'),
      ).toBeNull();

      mockFulltextService.getFulltext.mockRejectedValueOnce(
        new Error('S3 reset'),
      );
      mockItemQueryService.getPermissions.mockRejectedValueOnce(
        new Error('Timeout'),
      );
      const degraded = await service.getReaderBootstrap(USER_ID, ITEM_ID, {
        projectId: PROJECT_ID,
      });
      expect(degraded?.degraded).toBe(true);
      expect(degraded?.degradedBranches).toEqual(['fulltext', 'permissions']);
      expect(degraded?.fulltext).toBeNull();

      mockItemQueryService.getItem.mockClear();
      const [r1, r2, r3] = await Promise.all([
        service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
        service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
        service.getReaderBootstrap(USER_ID, ITEM_ID, { projectId: PROJECT_ID }),
      ]);
      expect(mockItemQueryService.getItem).toHaveBeenCalledTimes(1);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });
  });

  describe('LibraryBootstrapService', () => {
    it('aggregates workspace tags, items, and syncVersion while coalescing concurrent bootstrap requests', async () => {
      const mockItemQuery = {
        getCounts: jest.fn(async () => ({
          total: 2,
          unfiled: 1,
          starred: 0,
          trash: 0,
          itemTypes: { journalArticle: 2 },
          role: 'owner' as const,
          permissions: {
            canRead: true,
            canCreateItem: true,
            canEditItem: true,
            canDeleteItem: true,
            canPurgeItem: true,
            canManageCollections: true,
            canImport: true,
            canExport: true,
            canAnnotate: true,
          },
        })),
        listItems: jest.fn(
          () =>
            new Promise<{
              items: Array<{ id: string }>;
              meta: { hasNextPage: boolean; totalCount: number };
            }>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    items: [{ id: 'it-1' }, { id: 'it-2' }],
                    meta: { hasNextPage: false, totalCount: 2 },
                  }),
                1,
              ),
            ),
        ),
      };

      const bootstrapService = new LibraryBootstrapService(
        { findUserFeedSubscriptions: jest.fn(async () => []) } as never,
        mockItemQuery as never,
        {
          getCollections: jest.fn(async () => ({
            collections: [{ id: 'col-1', name: 'ML' }],
            total: 1,
          })),
        } as never,
        {
          findAll: jest.fn(async () => [{ id: 'ss-1', name: 'Recent AI' }]),
        } as never,
        new TypesService(),
        { getLatestSequence: jest.fn(async () => 42n) } as never,
        {
          getTags: jest.fn(async () => [{ id: 'tag-1', name: 'llm', count: 2 }]),
        } as never,
      );

      const calls = await Promise.all(
        Array.from({ length: 20 }, () =>
          bootstrapService.getBootstrap(USER_ID, { view: 'all', limit: 50 }),
        ),
      );
      expect(mockItemQuery.listItems).toHaveBeenCalledTimes(1);
      expect(calls[0].tags).toEqual([{ id: 'tag-1', name: 'llm', count: 2 }]);
      expect(calls[0].syncVersion?.version).toBe('42');
      expect(calls[0].items).toHaveLength(2);
    });
  });
});
