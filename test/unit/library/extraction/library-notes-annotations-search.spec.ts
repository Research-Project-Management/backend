import { SearchRepository } from '@/modules/library/search/repositories/search.repository';
import { formatLiteratureNoteMarkdown } from '@/modules/library/catalog/domain/notes.domain';
import {
  buildTipTapDocFromText,
  extractPlainTextFromTipTap,
  stripNoteHtml,
} from '@/modules/library/core/domain/renamer.domain';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { NotesRepository } from '@/modules/library/catalog/repositories/notes.repository';
import { AnnotationsRepository } from '@/modules/library/extraction/repositories/annotations.repository';
import { AnnotationNormalizer } from '@/modules/library/extraction/domain/annotations.domain';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ItemsMapper } from '@/modules/library/core';
import {
  CreateAnnotationDto,
  UpdateAnnotationDto,
  BatchAnnotationsDto,
} from '@/modules/library/extraction/dto/annotations.dto';
import {
  extractPdfBibliographyReferences,
  splitCitationSentences,
} from '@/modules/library/extraction/providers/pdf-outline.extractor';

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
        'flux://open-pdf/library/papers/paper-123?attachmentId=att-456&page=1&annotation=ann-999',
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
        'https://research.flux.ac/library/papers/paper-123?attachmentId=att-456&page=1&annotation=ann-999',
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
      expect(normalized.notes?.map((n) => n.content)).toEqual([
        'Note A',
        'Note B',
      ]);
    });

    it('should strip HTML tags from raw note content', () => {
      const cleaned = stripNoteHtml(
        '<div><p>Paragraph inside HTML tags</p></div>',
      );
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

      const mapped = ItemsMapper.toDomain(rawItem as any);
      expect(mapped.attachments).toHaveLength(2);
      expect(mapped.attachments[0].title).toBe('Author Manuscript PDF');
      expect(mapped.attachments[1].title).toBe('Publisher Webpage Snapshot');
      expect(mapped.primaryFile?.title).toBe('Author Manuscript PDF');
    });

    it('should synchronize contentMd from contentJson when updating a note with only contentJson', async () => {
      const noteMock = {
        findFirst: jest.fn().mockResolvedValue({
          id: 'note-1',
          userId: '018f3a21-1234-7000-8000-000000000001',
          projectId: null,
          title: 'Old Title',
          contentMd: 'Stale old markdown',
          contentJson: { type: 'doc', content: [] },
          tags: [],
          version: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const mockPrisma = {
        note: noteMock,
        libraryNote: noteMock,
      };
      const notesRepo = new NotesRepository(
        mockPrisma as unknown as PrismaService,
      );
      const tiptapDoc = buildTipTapDocFromText(
        'Updated first paragraph.\n\nUpdated second paragraph.',
      );
      expect(extractPlainTextFromTipTap(tiptapDoc)).toBe(
        'Updated first paragraph.\n\nUpdated second paragraph.',
      );

      const updated = await notesRepo.update(
        '018f3a21-1234-7000-8000-000000000001',
        'note-1',
        1,
        { contentJson: tiptapDoc },
      );

      expect(updated.contentMd).toBe(
        'Updated first paragraph.\n\nUpdated second paragraph.',
      );
    });

    it('should omit rectCoords from SQL UPDATE when only comment/color/tags are updated and preserve image type', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const annRepo = new AnnotationsRepository({
        annotation: { updateMany },
      } as unknown as PrismaService);

      const existing = {
        id: 'ann-1',
        attachmentId: 'att-1',
        type: 'image' as const,
        pageIndex: 1,
        pageLabel: '1',
        annotationSortIndex: '0001|01000|01000',
        color: '#ffd400',
        quoteText: '',
        comment: 'Initial comment',
        tags: [],
        rectCoords: [
          { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, width: 0.4, height: 0.4 },
        ],
        authorId: 'user-1',
        version: 1,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await annRepo.update(
        'ann-1',
        1,
        { comment: 'Updated comment without touching coords' },
        undefined,
        existing,
      );

      const updateCallData = updateMany.mock.calls[0][0].data;
      expect(updateCallData.comment).toBe(
        'Updated comment without touching coords',
      );
      expect('rectCoords' in updateCallData).toBe(false);

      const normalizer = new AnnotationNormalizer();
      expect(normalizer.parseType('image')).toBe('image');
    });
  });

  describe('6. Annotation DTO ValidationPipe Coordinate Preservation', () => {
    const validationPipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      stopAtFirstError: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    });

    it('preserves rects, rectCoords, and boundingRect under NestJS whitelist + implicit conversion', async () => {
      const box = {
        x1: 0.12,
        y1: 0.24,
        x2: 0.68,
        y2: 0.29,
        width: 0.56,
        height: 0.05,
      };
      const inkBox = {
        ...box,
        paths: [
          [
            [0.12, 0.24],
            [0.4, 0.27],
          ],
        ],
      };

      const created = await validationPipe.transform(
        {
          type: 'highlight',
          pageIndex: 0,
          color: '#ffd400',
          quoteText: 'residual learning framework',
          rects: [box],
          tags: [],
        },
        { type: 'body', metatype: CreateAnnotationDto },
      );
      expect(created.rects).toEqual([box]);

      const withExplicitRectCoords = await validationPipe.transform(
        {
          type: 'highlight',
          pageIndex: 0,
          rectCoords: [box],
        },
        { type: 'body', metatype: CreateAnnotationDto },
      );
      expect(withExplicitRectCoords.rectCoords).toEqual([box]);

      const updated = await validationPipe.transform(
        {
          rects: [box],
          boundingRect: box,
          expectedVersion: 1,
        },
        { type: 'body', metatype: UpdateAnnotationDto },
      );
      expect(updated.rects).toEqual([box]);
      expect(updated.boundingRect).toEqual(box);

      const batched = await validationPipe.transform(
        {
          upserts: [{ type: 'ink', pageIndex: 0, rects: [inkBox] }],
          deletes: [],
        },
        { type: 'body', metatype: BatchAnnotationsDto },
      );
      expect(batched.upserts[0].rects).toEqual([inkBox]);
    });
  });

  describe('7. PDF Reference Extraction with Hyphenated & Single-Letter Initials', () => {
    it('does not split sentences prematurely on C.-Y. or I. J. author initials', () => {
      const sample =
        'C.-Y. Lee, S. Xie, P. Gallagher, Z. Zhang, and Z. Tu. Deeply-supervised nets. arXiv:1409.5185, 2014.';
      expect(splitCitationSentences(sample)).toEqual([
        'C.-Y. Lee, S. Xie, P. Gallagher, Z. Zhang, and Z. Tu',
        'Deeply-supervised nets',
        'arXiv:1409.5185, 2014.',
      ]);

      const refs = extractPdfBibliographyReferences(`
References
[9] I. J. Goodfellow, D. Warde-Farley, M. Mirza, A. Courville, and Y. Bengio. Maxout networks. arXiv:1302.4389, 2013.
[24] C.-Y. Lee, S. Xie, P. Gallagher, Z. Zhang, and Z. Tu. Deeply-supervised nets. arXiv:1409.5185, 2014.
      `);
      expect(refs).toHaveLength(2);
      expect(refs[0].title).toBe('Maxout networks');
      expect(refs[0].authors).toEqual([
        'I. J. Goodfellow',
        'D. Warde-Farley',
        'M. Mirza',
        'A. Courville',
        'Y. Bengio',
      ]);
      expect(refs[1].title).toBe('Deeply-supervised nets');
      expect(refs[1].authors).toEqual([
        'C.-Y. Lee',
        'S. Xie',
        'P. Gallagher',
        'Z. Zhang',
        'Z. Tu',
      ]);
      expect(refs[1].year).toBe(2014);
      expect(refs[1].arxivId).toBe('1409.5185');
    });

    it('splits unnumbered multi-line APA/ICLR references under LaTeX small-caps R EFERENCES where year appears on the last line', () => {
      const refs = extractPdfBibliographyReferences(`
R EFERENCES
Duchi, John, Hazan, Elad, and Singer, Yoram. Adaptive subgradient methods for online learning and
stochastic optimization. The Journal of Machine Learning Research, 12:2121-2159, 2011.
Graves, Alex. Generating sequences with recurrent neural networks. arXiv preprint arXiv:1308.0850,
2013.
Pascanu, Razvan and Bengio, Yoshua. Revisiting natural gradient for deep networks. arXiv preprint
arXiv:1301.3584, 2013.
Tieleman, T. and Hinton, G. Lecture 6.5 - RMSProp, COURSERA: Neural Networks for Machine
Learning. Technical report, 2012.
      `);
      expect(refs).toHaveLength(4);
      expect(refs[0].year).toBe(2011);
      expect(refs[0].authors).toEqual(['Duchi, John', 'Hazan, Elad', 'Singer, Yoram']);
      expect(refs[1].year).toBe(2013);
      expect(refs[1].arxivId).toBe('1308.0850');
      expect(refs[2].year).toBe(2013);
      expect(refs[2].arxivId).toBe('1301.3584');
      expect(refs[3].year).toBe(2012);
    });
  });
});
