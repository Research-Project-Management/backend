import { Test, TestingModule } from '@nestjs/testing';
import {
  SuggestionService,
  applyReplacementSafely,
} from '@/modules/document/suggestion/suggestion.service';
import { SuggestionRepository } from '@/modules/document/suggestion/suggestion.repository';
import { PageService } from '@/modules/document/page/page.service';
import { PrismaService } from '@/core/database/prisma.service';
import { RedisCacheService } from '@/core/cache/redis.service';
import { YjsDocumentManager } from '@/modules/document/collaboration/yjs-document.manager';
import { CollaborationGateway } from '@/modules/document/collaboration/collaboration.gateway';
import { SuggestionStatus } from '@prisma/client';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

describe('SuggestionService & Track Changes Engine (Matt Pocock Deep Module Tests)', () => {
  describe('applyReplacementSafely (Pure Function Isolation)', () => {
    const sampleDoc = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\section{Introduction}',
      'Overleaf is a great collaborative platform.',
      'It supports real-time editing.',
      '\\end{document}',
    ].join('\n');

    it('should perform exact line range replacement', () => {
      const result = applyReplacementSafely(sampleDoc, {
        type: 'replace',
        originalText: 'great',
        suggestedText: 'superb',
        fromLine: 4,
        toLine: 4,
      });

      expect(result).toContain('Overleaf is a superb collaborative platform.');
      expect(result).not.toContain('great');
    });

    it('should handle pure insertions without originalText anchor', () => {
      const result = applyReplacementSafely(sampleDoc, {
        type: 'insert',
        suggestedText: '% Note for reviewers',
        fromLine: 4,
        toLine: 4,
      });

      const lines = result.split('\n');
      expect(lines[3]).toBe('% Note for reviewers');
      expect(lines[4]).toBe('Overleaf is a great collaborative platform.');
    });

    it('should handle line drift compensation when original text has shifted positions', () => {
      // Suppose original was on line 4, but due to edits above it is now at line 5
      const driftedDoc = [
        '\\documentclass{article}',
        '% New line 1 added earlier',
        '\\begin{document}',
        '\\section{Introduction}',
        'Overleaf is a great collaborative platform.',
        '\\end{document}',
      ].join('\n');

      const result = applyReplacementSafely(driftedDoc, {
        type: 'replace',
        originalText: 'Overleaf is a great collaborative platform.',
        suggestedText: 'Overleaf is an exceptional collaborative platform.',
        fromLine: 3, // Old line number before drift
        toLine: 4,
      });

      expect(result).toContain(
        'Overleaf is an exceptional collaborative platform.',
      );
    });

    it('should throw ConflictException if originalText was modified or deleted by someone else', () => {
      expect(() =>
        applyReplacementSafely(sampleDoc, {
          type: 'replace',
          originalText: 'This sentence was deleted already',
          suggestedText: 'Replacement',
          fromLine: 4,
          toLine: 4,
        }),
      ).toThrow(ConflictException);
    });

    it('should perform deletion accurately', () => {
      const result = applyReplacementSafely(sampleDoc, {
        type: 'delete',
        originalText: 'great ',
        suggestedText: '',
        fromLine: 4,
        toLine: 4,
      });

      expect(result).toContain('Overleaf is a collaborative platform.');
    });
  });

  describe('SuggestionService Integration with Live Yjs & WebSocket Gateway', () => {
    let service: SuggestionService;
    let repo: any;
    let pageService: any;
    let prisma: any;
    let cache: any;
    let yjsManager: any;
    let collaborationGateway: any;

    const mockPageId = '11111111-1111-1111-1111-111111111111';
    const mockUserId = '99999999-9999-9999-9999-999999999999';
    const mockSuggestionId = '55555555-5555-5555-5555-555555555555';
    const mockBinaryUpdate = new Uint8Array([9, 8, 7, 6]);

    beforeEach(async () => {
      repo = {
        create: jest.fn(),
        findById: jest.fn(),
        findByPageId: jest.fn(),
        update: jest.fn(),
        updateStatusMany: jest.fn(),
      };

      pageService = {
        findPageById: jest.fn().mockResolvedValue({
          id: mockPageId,
          projectId: 'proj-1',
          parentPageId: null,
          title: 'main.tex',
          content: 'Initial LaTeX content\nSecond line',
          isLocked: false,
        }),
        checkUserAccess: jest.fn().mockResolvedValue(true),
        invalidatePageCache: jest.fn().mockResolvedValue(undefined),
      };

      prisma = {
        page: {
          update: jest
            .fn()
            .mockResolvedValue({ id: mockPageId, content: 'Updated' }),
        },
        pageSuggestion: {
          update: jest.fn().mockResolvedValue({
            id: mockSuggestionId,
            status: SuggestionStatus.accepted,
            author: { id: 'author-1', name: 'Alice' },
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        pageVersion: {
          create: jest.fn().mockResolvedValue({ id: 'ver-1' }),
        },
        $transaction: jest.fn(async (tasks) => Promise.all(tasks)),
      };

      cache = {
        del: jest.fn().mockResolvedValue(undefined),
      };

      yjsManager = {
        hasActiveSession: jest.fn().mockReturnValue(true),
        getText: jest
          .fn()
          .mockReturnValue('Live in-memory text\nSecond line with target'),
        replaceText: jest.fn().mockResolvedValue(mockBinaryUpdate),
      };

      collaborationGateway = {
        broadcastYjsUpdate: jest.fn(),
        broadcastRoomEvent: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SuggestionService,
          { provide: SuggestionRepository, useValue: repo },
          { provide: PageService, useValue: pageService },
          { provide: PrismaService, useValue: prisma },
          { provide: RedisCacheService, useValue: cache },
          { provide: YjsDocumentManager, useValue: yjsManager },
          { provide: CollaborationGateway, useValue: collaborationGateway },
        ],
      }).compile();

      service = module.get<SuggestionService>(SuggestionService);
    });

    it('should create suggestion and broadcast suggestion:created', async () => {
      repo.create.mockResolvedValue({
        id: mockSuggestionId,
        type: 'replace',
        originalText: 'target',
        suggestedText: 'replacement',
        status: SuggestionStatus.pending,
      });

      const result = await service.createSuggestion(mockPageId, mockUserId, {
        type: 'replace',
        originalText: 'target',
        suggestedText: 'replacement',
        fromLine: 2,
        toLine: 2,
      });

      expect(result.id).toBe(mockSuggestionId);
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'suggestion:created',
        expect.objectContaining({ pageId: mockPageId }),
      );
    });

    it('should reject creating suggestion if document is locked', async () => {
      pageService.findPageById.mockResolvedValueOnce({
        id: mockPageId,
        isLocked: true,
      });

      await expect(
        service.createSuggestion(mockPageId, mockUserId, {
          type: 'insert',
          suggestedText: 'new line',
          fromLine: 1,
          toLine: 1,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject creating suggestion if fromLine > toLine', async () => {
      await expect(
        service.createSuggestion(mockPageId, mockUserId, {
          type: 'replace',
          fromLine: 10,
          toLine: 5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept suggestion, apply to live Yjs, broadcast yjs:update, create checkpoint and broadcast suggestion:accepted', async () => {
      repo.findById.mockResolvedValue({
        id: mockSuggestionId,
        pageId: mockPageId,
        type: 'replace',
        originalText: 'target',
        suggestedText: 'super-target',
        fromLine: 2,
        toLine: 2,
        status: SuggestionStatus.pending,
        author: { id: 'author-1', name: 'Alice' },
      });

      const result = await service.acceptSuggestion(
        mockPageId,
        mockSuggestionId,
        mockUserId,
      );

      expect(result.ok).toBe(true);

      // Verify live Yjs session was read and updated
      expect(yjsManager.hasActiveSession).toHaveBeenCalledWith(mockPageId);
      expect(yjsManager.getText).toHaveBeenCalledWith(mockPageId);
      expect(yjsManager.replaceText).toHaveBeenCalledWith(
        mockPageId,
        expect.stringContaining('super-target'),
        mockUserId,
      );

      // Verify binary update was broadcast to WebSocket room
      expect(collaborationGateway.broadcastYjsUpdate).toHaveBeenCalledWith(
        mockPageId,
        mockBinaryUpdate,
      );

      // Verify PageVersion checkpoint was created
      expect(prisma.pageVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pageId: mockPageId,
            eventType: 'collaborative_checkpoint',
          }),
        }),
      );

      // Verify domain event broadcast
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'suggestion:accepted',
        expect.objectContaining({
          pageId: mockPageId,
          resolvedBy: mockUserId,
        }),
      );
    });

    it('should reject suggestion and broadcast suggestion:rejected', async () => {
      repo.findById.mockResolvedValue({
        id: mockSuggestionId,
        pageId: mockPageId,
        status: SuggestionStatus.pending,
      });
      repo.update.mockResolvedValue({
        id: mockSuggestionId,
        status: SuggestionStatus.rejected,
      });

      const result = await service.rejectSuggestion(
        mockPageId,
        mockSuggestionId,
        mockUserId,
      );

      expect(result.ok).toBe(true);
      expect(repo.update).toHaveBeenCalledWith(
        mockSuggestionId,
        expect.objectContaining({
          status: SuggestionStatus.rejected,
          resolvedById: mockUserId,
        }),
      );
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'suggestion:rejected',
        expect.objectContaining({
          pageId: mockPageId,
          suggestionId: mockSuggestionId,
        }),
      );
    });

    it('should accept all pending suggestions and apply batch update', async () => {
      repo.findByPageId.mockResolvedValue([
        {
          id: 'sugg-1',
          type: 'replace',
          originalText: 'target',
          suggestedText: 'first-replacement',
          fromLine: 2,
          toLine: 2,
          status: SuggestionStatus.pending,
        },
      ]);

      const result = await service.acceptAllSuggestions(mockPageId, mockUserId);

      expect(result.ok).toBe(true);
      expect(result.acceptedCount).toBe(1);
      expect(yjsManager.replaceText).toHaveBeenCalled();
      expect(collaborationGateway.broadcastYjsUpdate).toHaveBeenCalled();
      expect(collaborationGateway.broadcastRoomEvent).toHaveBeenCalledWith(
        mockPageId,
        'suggestions:accepted-all',
        expect.objectContaining({
          pageId: mockPageId,
          count: 1,
        }),
      );
    });
  });
});
