import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/domain/notes.domain';
import { buildTipTapDocFromText, stripNoteHtml } from '@/modules/library/core/domain/tiptap.domain';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { PrismaService } from '@/core';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';

describe('Library Notes, Annotations & Deep Search Parity', () => {
  describe('1. SearchRepository - Zotero Parity Deep Full-Text Query Builder', () => {
    let searchRepo: SearchRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        item: {
          findMany: jest.fn(),
          count: jest.fn(),
        },
      };
      searchRepo = new SearchRepository(mockPrisma as PrismaService);
    });

    it('should build text search where clause covering Title, Abstract, DOI, Creators, Notes, and PDF Annotations/Comments', () => {
      const query = 'self-attention mechanism';
      const whereClause = (searchRepo as any).buildTextWhereIlike(query);

      expect(whereClause.OR).toBeDefined();
      expect(Array.isArray(whereClause.OR)).toBe(true);

      // Check standard bibliographic metadata coverage
      expect(whereClause.OR).toEqual(
        expect.arrayContaining([
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
          { doi: { contains: query, mode: 'insensitive' } },
          { citationKey: { contains: query, mode: 'insensitive' } },
        ]),
      );

      // Check deep Literature Notes search coverage
      const noteSearchClause = whereClause.OR.find(
        (clause: any) => clause.notesList !== undefined,
      );
      expect(noteSearchClause).toBeDefined();
      expect(noteSearchClause.notesList.some.deletedAt).toBeNull();
      expect(noteSearchClause.notesList.some.OR).toEqual([
        { title: { contains: query, mode: 'insensitive' } },
        { contentMd: { contains: query, mode: 'insensitive' } },
      ]);

      // Check deep in-PDF Annotations & Highlight comments search coverage
      const annotationSearchClause = whereClause.OR.find(
        (clause: any) => clause.attachments !== undefined,
      );
      expect(annotationSearchClause).toBeDefined();
      expect(annotationSearchClause.attachments.some.deletedAt).toBeNull();
      expect(
        annotationSearchClause.attachments.some.annotations.some.deletedAt,
      ).toBeNull();
      expect(
        annotationSearchClause.attachments.some.annotations.some.OR,
      ).toEqual([
        { quoteText: { contains: query, mode: 'insensitive' } },
        { comment: { contains: query, mode: 'insensitive' } },
      ]);
    });
  });

  describe('3. Literature Notes Multi-Protocol Backlink Formatter', () => {
    const mockItem = {
      id: 'paper-123',
      title: 'Attention Is All You Need',
      year: 2017,
      citekey: 'vaswani2017',
      creators: [{ lastName: 'Vaswani', fullName: 'Ashish Vaswani' }],
    };

    const mockAnnotations = [
      {
        id: 'ann-999',
        attachmentId: 'att-456',
        pageIndex: 0,
        color: '#ff6666',
        quoteText: 'The Transformer is the first transduction model.',
        comment: 'Groundbreaking finding',
      },
    ];

    it('should format backlinks with default flux:// protocol', () => {
      const md = formatLiteratureNoteMarkdown(mockItem, mockAnnotations);
      expect(md).toContain('🔴 Critical');
      expect(md).toContain(
        'flux://open-pdf/library/items/att-456?page=1&annotation=ann-999',
      );
    });

    it('should format backlinks with zotero:// protocol when specified', () => {
      const md = formatLiteratureNoteMarkdown(mockItem, mockAnnotations, {
        protocol: 'zotero',
      });
      expect(md).toContain('zotero://open-pdf/0_att-456/1?annotation=ann-999');
    });

    it('should format backlinks with web https:// protocol when specified', () => {
      const md = formatLiteratureNoteMarkdown(mockItem, mockAnnotations, {
        protocol: 'web',
        webBaseUrl: 'https://research.flux.ac',
      });
      expect(md).toContain(
        'https://research.flux.ac/library/papers/paper-123?page=1&annotation=ann-999',
      );
    });
  });

  describe('4. Standardized Note Ingestion & TipTap AST Parity', () => {
    const policy = new NormalizationPolicy();

    it('should split multi-paragraph text into clean TipTap paragraph nodes', () => {
      const multiline =
        'First paragraph summary.\n\nSecond paragraph details.\n\nThird paragraph conclusion.';
      const doc = buildTipTapDocFromText(multiline);

      expect(doc.type).toBe('doc');
      expect(Array.isArray(doc.content)).toBe(true);
      const content = doc.content as Array<any>;
      expect(content).toHaveLength(3);
      expect(content[0]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'First paragraph summary.' }],
      });
      expect(content[1]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Second paragraph details.' }],
      });
      expect(content[2]).toEqual({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Third paragraph conclusion.' }],
      });
    });

    it('should handle empty or whitespace text gracefully in TipTap doc generator', () => {
      const emptyDoc = buildTipTapDocFromText('   ');
      expect(emptyDoc).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph' }],
      });
    });

    it('should eliminate duplicate notes during NormalizationPolicy.normalize', () => {
      const normalized = policy.normalize({
        title: 'Test Paper',
        notes: ['Note A', 'Note A', 'Note B'],
      });
      expect(normalized.notes).toHaveLength(2);
      expect(normalized.notes?.map((n) => n.content)).toEqual(['Note A', 'Note B']);
    });

    it('should strip HTML tags from raw note content', () => {
      const cleaned = stripNoteHtml('<div><p>Paragraph inside HTML tags</p></div>');
      expect(cleaned).toBe('Paragraph inside HTML tags');
    });
  });

  describe('5. Standardized Multi-Attachment Ingestion & Mapper Parity', () => {
    it('should expose attachment title and primaryFile in ItemsMapper.toDomain', () => {
      const rawItem = {
        id: '018f3a21-1234-7000-8000-000000000005',
        title: 'Test Paper',
        itemType: 'journalArticle',
        attachments: [
          {
            id: 'att-1',
            filename: 'raw_file.pdf',
            fileId: '018f3a21-1234-7000-8000-000000000006',
            attachmentType: 'primary_pdf',
            metadata: { title: 'Author Manuscript PDF' },
          },
          {
            id: 'att-2',
            filename: 'snapshot.html',
            attachmentType: 'snapshot',
            title: 'Publisher Webpage Snapshot',
          },
        ],
      };

      const mapped = ItemsMapper.toDomain(rawItem as any) as any;
      expect(mapped.attachments).toHaveLength(2);
      expect(mapped.attachments[0].title).toBe('Author Manuscript PDF');
      expect(mapped.attachments[1].title).toBe('Publisher Webpage Snapshot');
      expect(mapped.primaryFile?.title).toBe('Author Manuscript PDF');
    });
  });
});
