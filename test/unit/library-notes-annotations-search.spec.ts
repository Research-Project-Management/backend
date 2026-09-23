import { SearchRepository } from '../../src/modules/library/search/infrastructure/repositories/search.repository';
import { CommandRepository } from '../../src/modules/library/bibliography/infrastructure/repositories/command.repository';
import { PrismaService } from '../../src/core/database/prisma.service';
import { formatLiteratureNoteMarkdown } from '../../src/modules/library/reader/application/utils/notes.utils';

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
          findMany: jest.fn().mockResolvedValue([
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
      expect(md).toContain(
        'zotero://open-pdf/0_att-456/1?annotation=ann-999',
      );
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
});
