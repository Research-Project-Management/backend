import { Test, TestingModule } from '@nestjs/testing';
import { UnprocessableEntityException } from '@nestjs/common';
import { ItemsService } from '@/modules/library/items/items.service';
import { QueryRepository } from '@/modules/library/items/repositories/query.repository';
import { CommandRepository } from '@/modules/library/items/repositories/command.repository';
import { TransactionService } from '@/modules/library/outbox/transaction.service';
import { PrismaService } from '@/core/database/prisma.service';
import { TagsService } from '@/modules/library/tags/tags.service';
import { CollectionsService } from '@/modules/library/collections/collections.service';
import { TypesService } from '@/modules/library/types/types.service';
import { RagProvider } from '@/modules/library/search/providers/rag.provider';
import { ItemTransformer } from '@/modules/library/items/transformers/item.transformer';
import { sanitizeItemTitle } from '@/modules/library/items/utils/items.utils';
import { VersionMismatchException } from '@/modules/library/core/errors/version-mismatch.exception';
import { ItemsMapper } from '@/modules/library/items/mappers/items.mapper';
import {
  resolveExtraPlainText,
  extractNonColumnExtraFields,
} from '@/modules/library/items/repositories/command.repository';

describe('Library Items — Authoritative Backend & Sanitization', () => {
  describe('sanitizeItemTitle (Domain Utility)', () => {
    it('should strip dangerous <script> tags and content', () => {
      const dirty = '<script>alert("xss")</script>Attention Is All You Need';
      expect(sanitizeItemTitle(dirty)).toBe('Attention Is All You Need');
    });

    it('should strip <style> tags and embedded HTML formatting', () => {
      const dirty =
        '<style>body{color:red}</style><h1>Quantum</h1> <p>Supremacy</p>';
      expect(sanitizeItemTitle(dirty)).toBe('Quantum Supremacy');
    });

    it('should decode HTML entities and strip enclosing LaTeX braces', () => {
      const dirty = '{Deep Learning} &amp; {Neural Networks}&#39; Future';
      expect(sanitizeItemTitle(dirty)).toBe(
        "Deep Learning & Neural Networks' Future",
      );
    });

    it('should collapse multi-whitespace and strip control characters', () => {
      const dirty =
        '  A   Deep   \x00\x1F\x07Reinforcement   Learning \t\n  Study   ';
      expect(sanitizeItemTitle(dirty)).toBe(
        'A Deep Reinforcement Learning Study',
      );
    });

    it('should return empty string for null, undefined, or whitespace-only inputs', () => {
      expect(sanitizeItemTitle(null)).toBe('');
      expect(sanitizeItemTitle(undefined)).toBe('');
      expect(sanitizeItemTitle('   ')).toBe('');
      expect(sanitizeItemTitle('<script>alert(1)</script>')).toBe('');
    });

    it('should truncate titles longer than 1000 characters', () => {
      const longTitle = 'A'.repeat(1200);
      const cleaned = sanitizeItemTitle(longTitle);
      expect(cleaned.length).toBe(1000);
    });
  });

  describe('ItemsService', () => {
    let service: ItemsService;
    let queryRepo: jest.Mocked<QueryRepository>;
    let commandRepo: jest.Mocked<CommandRepository>;
    let libraryTx: jest.Mocked<TransactionService>;
    let tagsService: jest.Mocked<TagsService>;

    const mockUserId = '11111111-1111-1111-1111-111111111111';

    beforeEach(async () => {
      const mockQueryRepo = {
        findById: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        getFulltext: jest.fn(),
      };

      const mockCommandRepo = {
        create: jest.fn(),
        update: jest.fn(),
        softDelete: jest.fn(),
        restore: jest.fn(),
      };

      const mockHelpers = {
        appendChange: jest.fn().mockResolvedValue(undefined),
        publishOutbox: jest.fn().mockResolvedValue(undefined),
      };

      const mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((cb) => cb({} as any, mockHelpers)),
      };

      const mockTagsService = {
        invalidateTagsCache: jest.fn().mockResolvedValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ItemsService,
          { provide: QueryRepository, useValue: mockQueryRepo },
          { provide: CommandRepository, useValue: mockCommandRepo },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: PrismaService, useValue: {} },
          { provide: TagsService, useValue: mockTagsService },
          { provide: CollectionsService, useValue: {} },
          { provide: TypesService, useValue: {} },
          { provide: RagProvider, useValue: {} },
          { provide: ItemTransformer, useValue: {} },
        ],
      }).compile();

      service = module.get<ItemsService>(ItemsService);
      queryRepo = module.get(QueryRepository);
      commandRepo = module.get(CommandRepository);
      libraryTx = module.get(TransactionService);
      tagsService = module.get(TagsService);
    });

    it('should throw UnprocessableEntityException when creating item with empty title', async () => {
      await expect(
        service.createItem(mockUserId, {
          title: '   ',
          itemType: 'journalArticle',
          uploadedById: mockUserId,
        }),
      ).rejects.toThrow(UnprocessableEntityException);

      await expect(
        service.createItem(mockUserId, {
          title: '<script>alert(1)</script>',
          itemType: 'journalArticle',
          uploadedById: mockUserId,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should sanitize title and persist valid item on createItem', async () => {
      const createdItem = {
        id: 'item-123',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        version: 1,
        doi: '10.1145/3065386',
      };
      commandRepo.create.mockResolvedValue(createdItem as any);

      const result = await service.createItem(mockUserId, {
        title: '<script>evil()</script>Attention Is All You Need',
        itemType: 'journalArticle',
        doi: '10.1145/3065386',
        uploadedById: mockUserId,
      });

      expect(commandRepo.create).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({
          title: 'Attention Is All You Need',
        }),
        expect.anything(),
        undefined,
      );
      expect(result).toBeDefined();
    });

    it('should throw UnprocessableEntityException when updating item with empty title', async () => {
      await expect(
        service.updateItem(mockUserId, 'item-123', 1, {
          title: '   ',
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should sanitize title on updateItem', async () => {
      const updatedItem = {
        id: 'item-123',
        title: 'Clean Updated Title',
        version: 2,
      };
      commandRepo.update.mockResolvedValue(updatedItem as any);

      await service.updateItem(mockUserId, 'item-123', 1, {
        title: ' <b>Clean</b> Updated {Title} ',
      });

      expect(commandRepo.update).toHaveBeenCalledWith(
        mockUserId,
        'item-123',
        1,
        expect.objectContaining({
          title: 'Clean Updated Title',
        }),
        expect.anything(),
        undefined,
      );
    });
  });

  describe('Zotero Schema v42 Parity — Mapping & Extra Preservation', () => {
    describe('ItemsMapper.toDomain', () => {
      it('should map base publicationTitle to type-specific fields', () => {
        const bookSection: any = ItemsMapper.toDomain({
          itemType: 'bookSection',
          publicationTitle: 'Handbook of AI',
        });
        expect(bookSection.bookTitle).toBe('Handbook of AI');
        expect(bookSection.publicationTitle).toBe('Handbook of AI');

        const confPaper: any = ItemsMapper.toDomain({
          itemType: 'conferencePaper',
          publicationTitle: 'Proceedings of NeurIPS 2023',
        });
        expect(confPaper.proceedingsTitle).toBe('Proceedings of NeurIPS 2023');

        const webpage: any = ItemsMapper.toDomain({
          itemType: 'webpage',
          publicationTitle: 'DeepMind Blog',
        });
        expect(webpage.websiteTitle).toBe('DeepMind Blog');
      });

      it('should map base publisher to university, institution, and repository', () => {
        const thesis: any = ItemsMapper.toDomain({
          itemType: 'thesis',
          publisher: 'MIT',
        });
        expect(thesis.university).toBe('MIT');
        expect(thesis.publisher).toBe('MIT');

        const report: any = ItemsMapper.toDomain({
          itemType: 'report',
          publisher: 'RAND Corporation',
        });
        expect(report.institution).toBe('RAND Corporation');

        const preprint: any = ItemsMapper.toDomain({
          itemType: 'preprint',
          publisher: 'arXiv',
        });
        expect(preprint.repository).toBe('arXiv');
      });

      it('should preserve and project non-column fields from extra plain-text', () => {
        const rawItem = {
          itemType: 'book',
          title: 'Clean Code',
          extra: 'Edition: 2nd\nnumPages: 464\nConference Name: ACM SIGMOD',
        };
        const mapped: any = ItemsMapper.toDomain(rawItem);
        expect(mapped.edition).toBe('2nd');
        expect(mapped.numPages).toBe(464);
        expect(mapped.numberOfPages).toBe(464);
        expect(mapped.conferenceName).toBe('ACM SIGMOD');
      });

      it('should synchronize canonical Zotero uppercase and lowercase aliases', () => {
        const item: any = ItemsMapper.toDomain({
          itemType: 'journalArticle',
          doi: '10.1234/test',
          isbn: '978-3-16-148410-0',
          issn: '2049-3630',
          pmid: '12345678',
          pmcid: 'PMC1234567',
          arxivId: '2301.00001',
          publicationDate: '2023-01-01',
          journalAbbr: 'Nat. Mach. Intell.',
        });
        expect(item.DOI).toBe('10.1234/test');
        expect(item.doi).toBe('10.1234/test');
        expect(item.ISBN).toBe('978-3-16-148410-0');
        expect(item.ISSN).toBe('2049-3630');
        expect(item.PMID).toBe('12345678');
        expect(item.PMCID).toBe('PMC1234567');
        expect(item.archiveId).toBe('2301.00001');
        expect(item.date).toBe('2023-01-01');
        expect(item.journalAbbreviation).toBe('Nat. Mach. Intell.');
      });
    });

    describe('resolveExtraPlainText & extractNonColumnExtraFields', () => {
      it('should extract non-column fields into extraFields object', () => {
        const data = {
          title: 'Paper Title',
          publisher: 'University Press',
          edition: '3rd',
          numPages: 350,
          conferenceName: 'ICML 2024',
          eventPlace: 'Vienna, Austria',
        };
        const extra = extractNonColumnExtraFields(data);
        expect(extra.edition).toBe('3rd');
        expect(extra.numPages).toBe(350);
        expect(extra.conferenceName).toBe('ICML 2024');
        expect(extra.eventPlace).toBe('Vienna, Austria');
        expect(extra.title).toBeUndefined();
        expect(extra.publisher).toBeUndefined();
      });

      it('should replace existing extra field in-place without duplicating', () => {
        const initialExtra = 'Edition: 1st\nLocation: Boston';
        const updated = resolveExtraPlainText(undefined, initialExtra, {
          edition: '2nd',
        });
        expect(updated).toBe('Edition: 2nd\nLocation: Boston');
      });

      it('should delete cleared field when null or empty string is passed', () => {
        const initialExtra = 'Edition: 1st\nLocation: Boston';
        const updated = resolveExtraPlainText(undefined, initialExtra, {
          edition: null,
        });
        expect(updated).toBe('Location: Boston');
      });
    });
  });
});
