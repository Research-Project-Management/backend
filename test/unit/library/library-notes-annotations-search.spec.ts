import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { CommandRepository } from '@/modules/library/catalog/repositories/command.repository';
import { PrismaService } from '@/core/database/prisma.service';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/utils/notes.utils';
import {
  prepareNotesToCreate,
  buildTipTapDocFromText,
  prepareAttachmentsToCreate,
  buildCommandCreateInput,
} from '@/modules/library/catalog/utils/command-payload.builder';
import { ItemsMapper } from '@/modules/library/catalog/utils/items.mapper';

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

  describe('2. CommandRepository - Restore Cascade for Notes, Attachments & Annotations', () => {
    let commandRepo: CommandRepository;
    let mockPrisma: any;

    beforeEach(() => {
      mockPrisma = {
        item: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'a0000000-0000-0000-0000-000000000001',
            userId: 'b0000000-0000-0000-0000-000000000002',
            deletedAt: new Date(),
            version: 1,
            metadata: {},
          }),
          update: jest.fn().mockResolvedValue({
            id: 'a0000000-0000-0000-0000-000000000001',
            deletedAt: null,
            version: 2,
            notesList: [],
            attachments: [],
          }),
        },
        note: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        attachment: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { id: 'c0000000-0000-0000-0000-000000000003' },
            ]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        annotation: {
          updateMany: jest.fn().mockResolvedValue({ count: 4 }),
        },
      };

      commandRepo = new CommandRepository(mockPrisma as PrismaService);
    });

    it('should cascade restore to associated notes, attachments, and annotations when restoring an item', async () => {
      const itemId = 'a0000000-0000-0000-0000-000000000001';
      const userId = 'b0000000-0000-0000-0000-000000000002';
      const attId = 'c0000000-0000-0000-0000-000000000003';

      const restored = await commandRepo.restore(userId, itemId);

      expect(restored).toBeDefined();

      // Verify Note restore cascade
      expect(mockPrisma.note.updateMany).toHaveBeenCalledWith({
        where: { itemId, deletedAt: { not: null } },
        data: { deletedAt: null },
      });

      // Verify Attachment and Annotation restore cascade
      expect(mockPrisma.attachment.findMany).toHaveBeenCalledWith({
        where: { itemId },
        select: { id: true },
      });
      expect(mockPrisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [attId] }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      expect(mockPrisma.annotation.updateMany).toHaveBeenCalledWith({
        where: { attachmentId: { in: [attId] }, deletedAt: { not: null } },
        data: { deletedAt: null },
      });

      // Verify Item restore
      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: itemId },
          data: { deletedAt: null, version: { increment: 1 } },
        }),
      );
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
    const userId = '00000000-0000-0000-0000-000000000001';
    const createdById = '00000000-0000-0000-0000-000000000002';

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

    it('should derive note title from first line following Zotero conventions', () => {
      const notes = [
        '# Core Findings on Attention Mechanisms\n\nDetailed analysis follows...',
      ];
      const prepared = prepareNotesToCreate(notes, userId, createdById);

      expect(prepared).toHaveLength(1);
      expect(prepared[0].title).toBe('Core Findings on Attention Mechanisms');
      expect(prepared[0].contentMd).toBe(notes[0]);
      expect(prepared[0].tags).toContain('imported');
      expect((prepared[0].contentJson as any).content).toHaveLength(2);
    });

    it('should truncate titles longer than 80 characters cleanly', () => {
      const longTitle =
        'This is an extremely long title for a note that exceeds eighty characters in length and therefore should be truncated';
      const notes = [longTitle];
      const prepared = prepareNotesToCreate(notes, userId, createdById);

      expect(prepared).toHaveLength(1);
      expect(prepared[0].title.length).toBeLessThanOrEqual(80);
      expect(prepared[0].title.endsWith('...')).toBe(true);
    });

    it('should preserve explicit title, custom tags, and existing TipTap AST when provided', () => {
      const customAST = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Pre-rendered AST' }],
          },
        ],
      };
      const notes = [
        {
          title: 'Custom User Title',
          content: 'Pre-rendered AST',
          contentJson: customAST,
          tags: ['deep-learning', 'methodology'],
        },
      ];
      const prepared = prepareNotesToCreate(notes, userId, createdById);

      expect(prepared).toHaveLength(1);
      expect(prepared[0].title).toBe('Custom User Title');
      expect(prepared[0].contentJson).toEqual(customAST);
      expect(prepared[0].tags).toContain('imported');
      expect(prepared[0].tags).toContain('deep-learning');
      expect(prepared[0].tags).toContain('methodology');
    });

    it('should eliminate duplicate notes and ignore existing notes list', () => {
      const notes = ['Note A', 'Note A', 'Note B'];
      const existing = [{ contentMd: 'Note B' }];
      const prepared = prepareNotesToCreate(
        notes,
        userId,
        createdById,
        existing,
      );

      expect(prepared).toHaveLength(1);
      expect(prepared[0].contentMd).toBe('Note A');
    });

    it('should strip HTML tags from raw note content', () => {
      const notes = ['<div><p>Paragraph inside HTML tags</p></div>'];
      const prepared = prepareNotesToCreate(notes, userId, createdById);

      expect(prepared).toHaveLength(1);
      expect(prepared[0].contentMd).toBe('Paragraph inside HTML tags');
      expect(prepared[0].title).toBe('Paragraph inside HTML tags');
    });
  });

  describe('5. Standardized Multi-Attachment Ingestion & Title Parity', () => {
    it('should parse multiple attachments preserving titles, linkModes, and types in metadata', () => {
      const rawAttachments = [
        {
          title: 'Full Text PDF',
          filename: 'vaswani2017.pdf',
          fileId: '018f3a21-1234-7000-8000-000000000001',
          mimeType: 'application/pdf',
          size: 1048576,
        },
        {
          title: 'ArXiv Snapshot',
          url: 'https://arxiv.org/abs/1706.03762',
          mimeType: 'text/html',
          attachmentType: 'snapshot',
          linkMode: 'imported_url',
          accessDate: '2024-05-18T10:00:00Z',
        },
        {
          title: 'Supplementary Appendix',
          filename: 'appendix.pdf',
          url: 'https://arxiv.org/pdf/1706.03762.pdf',
          mimeType: 'application/pdf',
          attachmentType: 'supplementary',
          linkMode: 'linked_url',
        },
      ];

      const prepared = prepareAttachmentsToCreate(rawAttachments);
      expect(prepared).toHaveLength(3);

      // Primary PDF check
      expect(prepared[0].attachmentType).toBe('primary_pdf');
      expect(prepared[0].filename).toBe('vaswani2017.pdf');
      expect((prepared[0].metadata as any)?.title).toBe('Full Text PDF');
      expect(prepared[0].linkMode).toBe('imported_file');

      // Snapshot check
      expect(prepared[1].attachmentType).toBe('snapshot');
      expect(prepared[1].linkMode).toBe('imported_url');
      expect((prepared[1].metadata as any)?.title).toBe('ArXiv Snapshot');
      expect((prepared[1].metadata as any)?.accessDate).toBe(
        '2024-05-18T10:00:00Z',
      );

      // Supplementary check
      expect(prepared[2].attachmentType).toBe('supplementary');
      expect(prepared[2].linkMode).toBe('linked_url');
      expect((prepared[2].metadata as any)?.title).toBe(
        'Supplementary Appendix',
      );
    });

    it('should fallback cleanly to single fileUrl/fileId when attachments array is absent', () => {
      const fallbackFileId = '018f3a21-1234-7000-8000-000000000002';
      const fallbackData = {
        filename: 'single_doc.pdf',
        fileUrl: '/api/files/018f3a21-1234-7000-8000-000000000002/content',
        size: 500000,
        mimeType: 'application/pdf',
      };

      const prepared = prepareAttachmentsToCreate(
        undefined,
        fallbackFileId,
        fallbackData,
      );
      expect(prepared).toHaveLength(1);
      expect(prepared[0].attachmentType).toBe('primary_pdf');
      expect(prepared[0].filename).toBe('single_doc.pdf');
      expect(prepared[0].fileId).toBe(fallbackFileId);
    });

    it('should accurately compute hasFile and attachmentCount in buildCommandCreateInput', async () => {
      const mockClient = {
        tag: {
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      } as any;

      const itemData: any = {
        title: 'Multi Attachment Paper',
        uploadedById: '018f3a21-1234-7000-8000-000000000003',
        attachments: [
          {
            title: 'Full Text PDF',
            filename: 'paper.pdf',
            fileId: '018f3a21-1234-7000-8000-000000000004',
            mimeType: 'application/pdf',
          },
          {
            title: 'Web Snapshot',
            url: 'https://example.com/snapshot.html',
            mimeType: 'text/html',
          },
        ],
      };

      const { createData } = await buildCommandCreateInput(
        '018f3a21-1234-7000-8000-000000000003',
        itemData,
        mockClient,
      );

      expect(createData.hasFile).toBe(true);
      expect(createData.attachmentCount).toBe(2);
      expect((createData.attachments as any)?.create).toHaveLength(2);
    });

    it('should expose attachment title in items.mapper.ts from att.title or metadata.title', () => {
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

      const mapped = ItemsMapper.toDomain(rawItem as any);
      expect(mapped.attachments).toHaveLength(2);
      expect(mapped.attachments[0].title).toBe('Author Manuscript PDF');
      expect(mapped.attachments[1].title).toBe('Publisher Webpage Snapshot');
      expect(mapped.primaryFile?.title).toBe('Author Manuscript PDF');
    });
  });
});
