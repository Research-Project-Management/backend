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
});
