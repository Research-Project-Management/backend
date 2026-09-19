import { Test, TestingModule } from '@nestjs/testing';
import { SuggestionService } from '@/modules/document/suggestion/suggestion.service';
import { SuggestionRepository } from '@/modules/document/suggestion/suggestion.repository';
import { CoreService } from '@/modules/document/core/core.service';
import { PrismaService } from '@/core/database/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SuggestionStatus } from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('Document SuggestionService (Track Changes)', () => {
  let service: SuggestionService;
  let repo: jest.Mocked<SuggestionRepository>;
  let coreService: jest.Mocked<CoreService>;
  let prisma: any;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockUserId = '11111111-1111-1111-1111-111111111111';
  const mockPageId = '33333333-3333-3333-3333-333333333333';
  const mockSuggestionId = '55555555-5555-5555-5555-555555555555';

  const mockAuthor = {
    id: mockUserId,
    name: 'Dr. Jane Doe',
    avatar: null,
    email: 'jane@flux.app',
  };

  const mockPage: any = {
    id: mockPageId,
    title: 'Main Paper',
    content:
      'Line 1: Introduction\nLine 2: Methodology\nLine 3: Results\nLine 4: Conclusion',
    parentPageId: null,
    isLocked: false,
  };

  const mockSuggestion: any = {
    id: mockSuggestionId,
    pageId: mockPageId,
    authorId: mockUserId,
    type: 'replace',
    originalText: 'Line 2: Methodology',
    suggestedText: 'Line 2: Advanced Methodology',
    fromLine: 2,
    fromColumn: 1,
    toLine: 2,
    toColumn: 20,
    description: 'Use advanced term',
    status: SuggestionStatus.pending,
    author: mockAuthor,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const mockRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      findByPageId: jest.fn(),
      update: jest.fn(),
      updateStatusMany: jest.fn(),
    };

    const mockCore = {
      findPageById: jest.fn(),
      checkUserAccess: jest.fn().mockResolvedValue(true),
    };

    const mockEmitter = {
      emit: jest.fn(),
    };

    prisma = {
      page: {
        update: jest.fn(),
      },
      pageSuggestion: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      pageVersion: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuggestionService,
        { provide: SuggestionRepository, useValue: mockRepo },
        { provide: CoreService, useValue: mockCore },
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get<SuggestionService>(SuggestionService);
    repo = module.get(SuggestionRepository);
    coreService = module.get(CoreService);
    eventEmitter = module.get(EventEmitter2);
  });

  describe('createSuggestion', () => {
    it('should create a pending suggestion and emit collaboration event', async () => {
      coreService.findPageById.mockResolvedValue(mockPage);
      repo.create.mockResolvedValue(mockSuggestion);

      const res = await service.createSuggestion(mockPageId, mockUserId, {
        type: 'replace',
        originalText: 'Line 2: Methodology',
        suggestedText: 'Line 2: Advanced Methodology',
        fromLine: 2,
        toLine: 2,
        description: 'Use advanced term',
      });

      expect(res).toEqual(mockSuggestion);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'replace',
          fromLine: 2,
          toLine: 2,
          status: SuggestionStatus.pending,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'document.collaboration.event',
        expect.objectContaining({
          type: 'suggestion-created',
          pageId: mockPageId,
        }),
      );
    });

    it('should throw NotFoundException if page does not exist', async () => {
      coreService.findPageById.mockResolvedValue(null);

      await expect(
        service.createSuggestion('non-existent-page', mockUserId, {
          type: 'insert',
          suggestedText: 'New text',
          fromLine: 1,
          toLine: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSuggestions', () => {
    it('should return list of suggestions from repository', async () => {
      repo.findByPageId.mockResolvedValue([mockSuggestion]);

      const res = await service.getSuggestions(
        mockPageId,
        SuggestionStatus.pending,
      );

      expect(res).toEqual([mockSuggestion]);
      expect(repo.findByPageId).toHaveBeenCalledWith(
        mockPageId,
        SuggestionStatus.pending,
      );
    });
  });

  describe('acceptSuggestion', () => {
    it('should apply atomic line replacement to page content and mark suggestion accepted', async () => {
      repo.findById.mockResolvedValue(mockSuggestion);
      coreService.findPageById.mockResolvedValue(mockPage);

      const updatedPageMock = {
        ...mockPage,
        content:
          'Line 1: Introduction\nLine 2: Advanced Methodology\nLine 3: Results\nLine 4: Conclusion',
      };
      const updatedSuggestionMock = {
        ...mockSuggestion,
        status: SuggestionStatus.accepted,
        resolvedById: mockUserId,
      };

      prisma.$transaction.mockResolvedValue([
        updatedPageMock,
        updatedSuggestionMock,
      ]);

      const res = await service.acceptSuggestion(
        mockPageId,
        mockSuggestionId,
        mockUserId,
      );

      expect(res.ok).toBe(true);
      expect(res.suggestion.status).toBe(SuggestionStatus.accepted);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'document.collaboration.event',
        expect.objectContaining({
          type: 'suggestion-accepted',
          pageId: mockPageId,
        }),
      );
    });

    it('should throw BadRequestException if suggestion is not pending', async () => {
      coreService.findPageById.mockResolvedValue(mockPage);
      repo.findById.mockResolvedValue({
        ...mockSuggestion,
        status: SuggestionStatus.accepted,
      });

      await expect(
        service.acceptSuggestion(mockPageId, mockSuggestionId, mockUserId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if suggestion belongs to another page', async () => {
      coreService.findPageById.mockResolvedValue(mockPage);
      repo.findById.mockResolvedValue({
        ...mockSuggestion,
        pageId: 'other-page-id',
      });

      await expect(
        service.acceptSuggestion(mockPageId, mockSuggestionId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejectSuggestion', () => {
    it('should mark suggestion as rejected and emit event without modifying page content', async () => {
      repo.findById.mockResolvedValue(mockSuggestion);
      const rejectedMock = {
        ...mockSuggestion,
        status: SuggestionStatus.rejected,
        resolvedById: mockUserId,
      };
      repo.update.mockResolvedValue(rejectedMock);

      const res = await service.rejectSuggestion(
        mockPageId,
        mockSuggestionId,
        mockUserId,
      );

      expect(res.ok).toBe(true);
      expect(res.suggestion.status).toBe(SuggestionStatus.rejected);
      expect(repo.update).toHaveBeenCalledWith(
        mockSuggestionId,
        expect.objectContaining({
          status: SuggestionStatus.rejected,
          resolvedById: mockUserId,
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'document.collaboration.event',
        expect.objectContaining({
          type: 'suggestion-rejected',
          pageId: mockPageId,
        }),
      );
    });
  });

  describe('rejectAllSuggestions', () => {
    it('should update all pending suggestions to rejected', async () => {
      repo.findByPageId.mockResolvedValue([mockSuggestion]);
      repo.updateStatusMany.mockResolvedValue(1);

      const res = await service.rejectAllSuggestions(mockPageId, mockUserId);

      expect(res).toEqual({ ok: true, rejectedCount: 1 });
      expect(repo.updateStatusMany).toHaveBeenCalledWith(
        [mockSuggestion.id],
        SuggestionStatus.rejected,
        mockUserId,
      );
    });
  });
});
