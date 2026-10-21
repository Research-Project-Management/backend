import { NotesService } from '@/modules/library/catalog/services/notes.service';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { TransactionService } from '@/modules/library/sync';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('NotesService (Architecturally Sound Clean Design)', () => {
  let notesService: NotesService;
  let mockRepo: jest.Mocked<Partial<NotesRepository>>;
  let mockTxService: jest.Mocked<Partial<TransactionService>>;
  let mockItemQuery: jest.Mocked<Partial<ItemQueryService>>;

  const USER_ID = '01a15274-ada1-710d-8b87-107bc6085af0';
  const ITEM_ID = '01a15318-d98e-75cf-bcc1-18872bbb1272';

  beforeEach(() => {
    mockRepo = {
      findItemAnnotations: jest.fn().mockResolvedValue([
        {
          id: 'ann-1',
          attachmentId: 'att-1',
          pageIndex: 0,
          annotationType: 'highlight',
          quoteText: 'The RPN is trained end-to-end',
          comment: 'Crucial mechanism',
          color: '#ffd400',
          annotationSortIndex: '00000|00000',
          createdAt: new Date('2026-10-20T04:31:00Z'),
          deletedAt: null,
        } as any,
      ]),
      create: jest.fn().mockImplementation((userId, data) =>
        Promise.resolve({
          id: 'note-1',
          userId,
          version: 1,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        } as any),
      ),
      syncItemNoteCount: jest.fn().mockResolvedValue(undefined),
    };

    mockTxService = {
      executeInTransaction: jest.fn().mockImplementation(async (callback) => {
        return callback({} as Prisma.TransactionClient, {
          appendChange: jest.fn().mockResolvedValue(undefined),
          publishOutbox: jest.fn().mockResolvedValue(undefined),
          recordTombstone: jest.fn().mockResolvedValue(undefined),
        } as any);
      }),
    };

    mockItemQuery = {
      findById: jest.fn().mockImplementation(async (userId, itemId, projectId) => {
        if (userId === USER_ID && itemId === ITEM_ID) {
          return {
            id: ITEM_ID,
            title: 'Faster R-CNN: Towards Real-Time Object Detection',
            userId: USER_ID,
            projectId: null,
            year: 2015,
            doi: '10.48550/arXiv.1506.01497v3',
            creators: [{ lastName: 'Ren' }],
          } as any;
        }
        return null;
      }),
      exists: jest.fn().mockImplementation(async (userId, itemId, projectId) => {
        return userId === USER_ID && itemId === ITEM_ID;
      }),
    };

    notesService = new NotesService(
      mockRepo as NotesRepository,
      mockTxService as TransactionService,
      mockItemQuery as ItemQueryService,
    );
  });

  it('compiles literature note from annotations via ItemQueryService', async () => {
    const result = await notesService.extractNotesFromAnnotations(USER_ID, ITEM_ID, {
      includeComments: true,
      tagColor: true,
    });

    expect(mockItemQuery.findById).toHaveBeenCalledWith(USER_ID, ITEM_ID, undefined);
    expect(mockRepo.findItemAnnotations).toHaveBeenCalledWith(ITEM_ID);
    expect(result.success).toBe(true);
    expect(result.totalExtracted).toBe(1);
    expect(result.literatureNote?.title).toContain('Literature Notes — Faster R-CNN');
    expect(result.literatureNote?.contentMd).toContain('The RPN is trained end-to-end');
  });

  it('throws NotFoundException when ItemQueryService cannot find the item or scope is mismatched', async () => {
    await expect(
      notesService.extractNotesFromAnnotations('different-user-id', ITEM_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('validates item existence using ItemQueryService in createNote with correct argument order', async () => {
    const note = await notesService.createNote(USER_ID, {
      itemId: ITEM_ID,
      title: 'Manual note',
      contentMd: 'Some content',
    });

    expect(mockItemQuery.exists).toHaveBeenCalledWith(USER_ID, ITEM_ID, undefined);
    expect(note.title).toBe('Manual note');
  });
});
