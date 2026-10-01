import { GrobidClient } from '@/modules/library/shared-kernel/infra/grobid/grobid.client';
import { ExtractionRepository } from '@/modules/library/extraction/core/adapters/extraction.repository';
import { buildTipTapDocFromText } from '@/modules/library/catalog/core/adapters/notes.utils';

describe('GROBID Tags & Notes Extraction & Synchronization', () => {
  describe('1. GrobidClient TEI Parsing for Keywords and Notes', () => {
    let client: GrobidClient;

    beforeEach(() => {
      client = new GrobidClient();
    });

    it('should extract keywords from TEI <term> elements', () => {
      const teiXml = `
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader>
            <fileDesc>
              <titleStmt>
                <title level="a">Attention Is All You Need</title>
              </titleStmt>
              <profileDesc>
                <textClass>
                  <keywords>
                    <term>Machine Learning</term>
                    <term>Neural Networks</term>
                    <term>Transformers</term>
                  </keywords>
                </textClass>
              </profileDesc>
            </fileDesc>
          </teiHeader>
        </TEI>
      `;

      const result = (client as any).parseTeiHeader(teiXml);
      expect(result.title).toBe('Attention Is All You Need');
      expect(result.keywords).toEqual([
        'Machine Learning',
        'Neural Networks',
        'Transformers',
      ]);
    });

    it('should extract document notes from TEI <note> elements', () => {
      const teiXml = `
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader>
            <fileDesc>
              <titleStmt>
                <title level="a">Deep Residual Learning for Image Recognition</title>
              </titleStmt>
              <notesStmt>
                <note type="funding">This research was supported by National Science Foundation grant IIS-1234567.</note>
                <note place="footnote">Corresponding author: Kaiming He (kaiminghe@example.com).</note>
              </notesStmt>
            </fileDesc>
          </teiHeader>
        </TEI>
      `;

      const result = (client as any).parseTeiHeader(teiXml);
      expect(result.notes).toBeDefined();
      expect(result.notes).toHaveLength(2);
      expect(result.notes![0]).toEqual({
        content: 'This research was supported by National Science Foundation grant IIS-1234567.',
        type: 'funding',
      });
      expect(result.notes![1]).toEqual({
        content: 'Corresponding author: Kaiming He (kaiminghe@example.com).',
        type: 'footnote',
      });
    });

    it('should filter out pagination, short fragments, and copyright boilerplate from notes', () => {
      const teiXml = `
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader>
            <fileDesc>
              <titleStmt>
                <title level="a">Test Paper</title>
              </titleStmt>
              <notesStmt>
                <note>page 1</note>
                <note>pp. 12-15</note>
                <note>All rights reserved</note>
                <note>© 2024 IEEE</note>
                <note>doi: 10.1145/1234567</note>
                <note>Short</note>
                <note type="author-note">This manuscript has been accepted for publication in ACM Computing Surveys.</note>
              </notesStmt>
            </fileDesc>
          </teiHeader>
        </TEI>
      `;

      const result = (client as any).parseTeiHeader(teiXml);
      expect(result.notes).toBeDefined();
      expect(result.notes).toHaveLength(1);
      expect(result.notes![0].content).toBe(
        'This manuscript has been accepted for publication in ACM Computing Surveys.',
      );
      expect(result.notes![0].type).toBe('author-note');
    });

    it('should deduplicate identical notes within the same TEI XML', () => {
      const teiXml = `
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader>
            <notesStmt>
              <note>Equal contribution: These authors contributed equally to this work.</note>
              <note>Equal contribution: These authors contributed equally to this work.</note>
            </notesStmt>
          </teiHeader>
        </TEI>
      `;

      const result = (client as any).parseTeiHeader(teiXml);
      expect(result.notes).toHaveLength(1);
    });
  });

  describe('2. TipTap AST JSON Generation for Literature Notes', () => {
    it('should convert raw text into standard TipTap doc JSON with paragraph nodes', () => {
      const text = 'First paragraph of extracted literature note.\n\nSecond paragraph with details.';
      const doc = buildTipTapDocFromText(text) as any;

      expect(doc.type).toBe('doc');
      expect(Array.isArray(doc.content)).toBe(true);
      expect(doc.content).toHaveLength(2);
      expect(doc.content[0]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'First paragraph of extracted literature note.' }],
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
      expect(normalized).toContain('Computer Science - Artificial Intelligence');
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
              tags: expect.arrayContaining(['Existing Tag', 'Machine Learning', 'NLP']),
              keywords: expect.arrayContaining(['Existing Tag', 'Machine Learning', 'NLP']),
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
            content: 'This paper proposes a new multi-head attention mechanism.',
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
            contentMd: 'This paper proposes a new multi-head attention mechanism.',
            tags: ['grobid', 'automatic'],
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
        notes: [
          { content: 'Existing note content here.' },
        ],
      });

      expect(created).toBe(0);
      expect(mockPrisma.note.create).not.toHaveBeenCalled();
      expect(mockPrisma.item.update).not.toHaveBeenCalled();
    });
  });
});
