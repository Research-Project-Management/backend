import { ExtractionRepository } from '@/modules/library/extraction/repositories/extraction.repository';
import { buildTipTapDocFromText } from '@/modules/library/shared-kernel/utils/tiptap.utils';

describe('Academic Tags & Notes Synchronization', () => {
  describe('1. TipTap AST JSON Generation for Literature Notes', () => {
    it('should convert raw text into standard TipTap doc JSON with paragraph nodes', () => {
      const text =
        'First paragraph of extracted literature note.\n\nSecond paragraph with details.';
      const doc = buildTipTapDocFromText(text) as any;

      expect(doc.type).toBe('doc');
      expect(Array.isArray(doc.content)).toBe(true);
      expect(doc.content).toHaveLength(2);
      expect(doc.content[0]).toEqual({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'First paragraph of extracted literature note.',
          },
        ],
      });
      expect(doc.content[1]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Second paragraph with details.' }],
      });
    });

    it('should handle empty or whitespace text gracefully', () => {
      const doc = buildTipTapDocFromText('') as any;
      expect(doc.type).toBe('doc');
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0].type).toBe('paragraph');
    });
  });

  describe('3. ExtractionRepository Tag and Note Synchronization', () => {
    let repo: ExtractionRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        itemTag: {
          count: jest.fn(),
          upsert: jest.fn(),
        },
        tag: {
          findFirst: jest.fn(),
          create: jest.fn(),
        },
        item: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        note: {
          count: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
        },
      };

      repo = new ExtractionRepository(mockPrisma);
    });

    it('should count item tags', async () => {
      mockPrisma.itemTag.count.mockResolvedValue(3);
      const count = await repo.countItemTags('item-123');
      expect(count).toBe(3);
      expect(mockPrisma.itemTag.count).toHaveBeenCalledWith({
        where: { itemId: 'item-123' },
      });
    });

    it('should count active item notes excluding deleted notes', async () => {
      mockPrisma.note.count.mockResolvedValue(2);
      const count = await repo.countItemNotes('item-123');
      expect(count).toBe(2);
      expect(mockPrisma.note.count).toHaveBeenCalledWith({
        where: { itemId: 'item-123', deletedAt: null },
      });
    });

    it('should synchronize academic tags with type "automatic" and update item metadata', async () => {
      mockPrisma.tag.findFirst.mockResolvedValue(null);
      mockPrisma.tag.create.mockImplementation((args: any) =>
        Promise.resolve({ id: `tag-${args.data.name}`, ...args.data }),
      );
      mockPrisma.itemTag.upsert.mockResolvedValue({});
      mockPrisma.item.findUnique.mockResolvedValue({
        metadata: { tags: ['Existing Tag'] },
      });
      mockPrisma.item.update.mockResolvedValue({});

      const normalized = await repo.syncItemTags({
        userId: 'user-1',
        itemId: 'item-1',
        rawTags: ['machine learning', 'cs.AI', 'nlp'],
      });

      expect(normalized).toContain('Machine Learning');
      expect(normalized).toContain(
        'Computer Science - Artificial Intelligence',
      );
      expect(normalized).toContain('NLP');

      // Tag created with type automatic
      expect(mockPrisma.tag.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'automatic',
          }),
        }),
      );

      // ItemTag created with type automatic
      expect(mockPrisma.itemTag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            itemId: 'item-1',
            type: 'automatic',
          }),
        }),
      );

      // Item metadata updated with merged tags & keywords
      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'item-1' },
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              tags: expect.arrayContaining([
                'Existing Tag',
                'Machine Learning',
                'NLP',
              ]),
              keywords: expect.arrayContaining([
                'Existing Tag',
                'Machine Learning',
                'NLP',
              ]),
            }),
          }),
        }),
      );
    });

    it('should create literature notes with TipTap doc JSON and update noteCount', async () => {
      mockPrisma.note.findMany.mockResolvedValue([]);
      mockPrisma.note.create.mockResolvedValue({ id: 'note-1' });
      mockPrisma.item.update.mockResolvedValue({});

      const created = await repo.createItemNotes({
        userId: 'user-1',
        itemId: 'item-1',
        notes: [
          {
            content:
              'This paper proposes a new multi-head attention mechanism.',
            type: 'summary',
          },
        ],
      });

      expect(created).toBe(1);
      expect(mockPrisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            itemId: 'item-1',
            userId: 'user-1',
            title: 'Extracted Note (summary)',
            contentMd:
              'This paper proposes a new multi-head attention mechanism.',
            tags: ['extracted', 'automatic'],
            contentJson: expect.objectContaining({
              type: 'doc',
              content: expect.any(Array),
            }),
          }),
        }),
      );

      expect(mockPrisma.item.update).toHaveBeenCalledWith({
        where: { id: 'item-1' },
        data: { noteCount: { increment: 1 } },
      });
    });

    it('should skip creating duplicate notes if content already exists on the item', async () => {
      mockPrisma.note.findMany.mockResolvedValue([
        { contentMd: 'Existing note content here.' },
      ]);

      const created = await repo.createItemNotes({
        userId: 'user-1',
        itemId: 'item-1',
        notes: [{ content: 'Existing note content here.' }],
      });

      expect(created).toBe(0);
      expect(mockPrisma.note.create).not.toHaveBeenCalled();
      expect(mockPrisma.item.update).not.toHaveBeenCalled();
    });
  });
});
