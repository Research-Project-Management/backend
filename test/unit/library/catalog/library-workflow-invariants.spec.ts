import { disambiguateCitationKey } from '@/modules/library/catalog/domain/command-payload.builder';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import { CollectionsRepository } from '@/modules/library/catalog/repositories/collections.repository';

describe('Library Workflow & Distributed Consistency Invariants', () => {
  const USER_ID = '01a15274-ada1-710d-8b87-107bc6085af0';
  const PROJECT_ID = '01a15318-d98e-75cf-bcc1-18872bbb1272';
  const ITEM_ID = '01a15400-0000-7000-8000-000000000001';

  describe('1. Citation Key Scope-Aware Disambiguation (BibTeX / BetterBibTeX convention)', () => {
    it('returns the base citation key unchanged when no collision exists in project scope', async () => {
      const mockClient = {
        item: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const result = await disambiguateCitationKey(
        mockClient as any,
        'vaswani2017attention',
        { userId: USER_ID, projectId: PROJECT_ID },
      );

      expect(result).toBe('vaswani2017attention');
      expect(mockClient.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            projectId: PROJECT_ID,
            deletedAt: null,
            citationKey: { startsWith: 'vaswani2017attention' },
          }),
        }),
      );
    });

    it('appends suffix "a" on first collision in the same project', async () => {
      const mockClient = {
        item: {
          findMany: jest.fn().mockResolvedValue([
            { citationKey: 'vaswani2017attention' },
          ]),
        },
      };

      const result = await disambiguateCitationKey(
        mockClient as any,
        'vaswani2017attention',
        { userId: USER_ID, projectId: PROJECT_ID },
      );

      expect(result).toBe('vaswani2017attentiona');
    });

    it('appends suffix "b" when both base key and suffix "a" already exist', async () => {
      const mockClient = {
        item: {
          findMany: jest.fn().mockResolvedValue([
            { citationKey: 'vaswani2017attention' },
            { citationKey: 'vaswani2017attentiona' },
          ]),
        },
      };

      const result = await disambiguateCitationKey(
        mockClient as any,
        'vaswani2017attention',
        { userId: USER_ID, projectId: PROJECT_ID },
      );

      expect(result).toBe('vaswani2017attentionb');
    });

    it('safely falls back to baseKey when client is a minimal mock without item model', async () => {
      const minimalClient = {};

      const result = await disambiguateCitationKey(
        minimalClient as any,
        'vaswani2017attention',
        { userId: USER_ID },
      );

      expect(result).toBe('vaswani2017attention');
    });
  });

  describe('2. Cascade Soft-Deletion of Child Notes (CommandRepository)', () => {
    let commandRepo: CommandRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        item: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findFirst: jest.fn(),
        },
        note: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      };
      commandRepo = new CommandRepository(mockPrisma);
    });

    it('cascades soft-delete to active child notes when item is soft-deleted', async () => {
      const success = await commandRepo.softDelete(USER_ID, ITEM_ID);

      expect(success).toBe(true);
      expect(mockPrisma.item.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: ITEM_ID, deletedAt: null }),
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(mockPrisma.note.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { itemId: ITEM_ID, deletedAt: null },
          data: { deletedAt: expect.any(Date) },
        }),
      );
    });
  });

  describe('3. Note Scope Inheritance (NotesRepository)', () => {
    let notesRepo: NotesRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        item: {
          findFirst: jest.fn().mockResolvedValue({
            id: ITEM_ID,
            projectId: PROJECT_ID,
            deletedAt: null,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        note: {
          count: jest.fn().mockResolvedValue(1),
          create: jest.fn().mockImplementation(({ data }) =>
            Promise.resolve({
              id: 'note-new',
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
            }),
          ),
        },
      };
      notesRepo = new NotesRepository(mockPrisma);
    });

    it('inherits parent item projectId when note does not specify projectId', async () => {
      const created = await notesRepo.create(USER_ID, {
        itemId: ITEM_ID,
        title: 'Project Inherited Note',
        contentMd: 'Important insight about transformer architectures.',
      });

      expect(created.projectId).toBe(PROJECT_ID);
      expect(mockPrisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: USER_ID,
            itemId: ITEM_ID,
            projectId: PROJECT_ID,
            title: 'Project Inherited Note',
          }),
        }),
      );
    });
  });

  describe('4. Collection Delete Cascade to Items, Notes, and Attachments (CollectionsRepository)', () => {
    let collectionsRepo: CollectionsRepository;
    let mockPrisma: any;
    const COLLECTION_ID = '01a15500-0000-7000-8000-000000000001';

    beforeEach(() => {
      mockPrisma = {
        collection: {
          findFirst: jest.fn().mockResolvedValue({
            id: COLLECTION_ID,
            userId: USER_ID,
            projectId: PROJECT_ID,
            version: 1,
            children: [],
          }),
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        collectionItem: {
          findMany: jest.fn().mockResolvedValue([{ itemId: ITEM_ID }]),
        },
        item: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        note: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        attachment: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      collectionsRepo = new CollectionsRepository(mockPrisma);
    });

    it('cascades soft-delete to items, notes, and attachments under cascade strategy', async () => {
      const success = await collectionsRepo.delete(
        USER_ID,
        COLLECTION_ID,
        'cascade',
        undefined,
        PROJECT_ID,
      );

      expect(success).toBe(true);
      expect(mockPrisma.item.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: [ITEM_ID] },
            deletedAt: null,
          }),
        }),
      );
      expect(mockPrisma.note.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemId: { in: [ITEM_ID] },
            deletedAt: null,
          },
        }),
      );
      expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            itemId: { in: [ITEM_ID] },
            deletedAt: null,
          },
        }),
      );
    });
  });
});
