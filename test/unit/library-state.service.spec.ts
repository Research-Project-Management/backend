import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StateService } from '@/modules/library/catalog/application/services/state.service';
import { StateRepository } from '@/modules/library/catalog/infrastructure/repositories/state.repository';
import {
  ReadingStatus,
  StateData,
} from '@/modules/library/catalog/domain/types/state.types';
import {
  formatStateDate,
  isValidRating,
  isValidCurrentPage,
  isValidScrollPosition,
  shouldAutoAdvanceToReading,
  toStateResponse,
} from '@/modules/library/catalog/application/utils/state.utils';
import {
  TransactionService,
  TransactionHelpers,
} from '@/modules/library/shared-kernel/outbox/transaction.service';
import { ITEM_EXISTENCE_PORT } from '@/modules/library/catalog/domain/ports/items.ports';
import { PrismaService } from '@/core/database/prisma.service';

describe('Library State Service — Reading Progress, Ratings & Viewer Position', () => {
  describe('State Utilities & Pure Domain Invariants', () => {
    it('formatStateDate should handle Date, ISO string, and null safely without throwing', () => {
      const now = new Date('2026-09-19T10:00:00.000Z');
      expect(formatStateDate(now)).toBe('2026-09-19T10:00:00.000Z');
      expect(formatStateDate('2026-09-19T10:00:00.000Z')).toBe(
        '2026-09-19T10:00:00.000Z',
      );
      expect(formatStateDate(null)).toBeNull();
      expect(formatStateDate(undefined)).toBeNull();
      expect(formatStateDate('invalid-date')).toBeNull();
    });

    it('isValidRating should validate 0 to 5 integers', () => {
      expect(isValidRating(0)).toBe(true);
      expect(isValidRating(3)).toBe(true);
      expect(isValidRating(5)).toBe(true);
      expect(isValidRating(undefined)).toBe(true);
      expect(isValidRating(null)).toBe(true);
      expect(isValidRating(-1)).toBe(false);
      expect(isValidRating(6)).toBe(false);
      expect(isValidRating(3.5)).toBe(false);
    });

    it('isValidCurrentPage should validate positive 1-based integers', () => {
      expect(isValidCurrentPage(1)).toBe(true);
      expect(isValidCurrentPage(42)).toBe(true);
      expect(isValidCurrentPage(undefined)).toBe(true);
      expect(isValidCurrentPage(null)).toBe(true);
      expect(isValidCurrentPage(0)).toBe(false);
      expect(isValidCurrentPage(-5)).toBe(false);
      expect(isValidCurrentPage(2.5)).toBe(false);
    });

    it('isValidScrollPosition should enforce max 16KB size limit', () => {
      expect(isValidScrollPosition({ page: 1, top: 120 })).toBe(true);
      expect(isValidScrollPosition([1, 2, 3])).toBe(true);
      expect(isValidScrollPosition(null)).toBe(true);
      expect(isValidScrollPosition(undefined)).toBe(true);
      expect(isValidScrollPosition('primitive-string')).toBe(false);

      const hugePayload = { data: 'x'.repeat(20000) };
      expect(isValidScrollPosition(hugePayload)).toBe(false);
    });

    it('shouldAutoAdvanceToReading should advance only when unread and moved forward', () => {
      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 2, null)).toBe(
        true,
      );
      expect(
        shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 1, { y: 200 }),
      ).toBe(true);
      expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 1, null)).toBe(
        false,
      );
      expect(shouldAutoAdvanceToReading(ReadingStatus.READING, 2, null)).toBe(
        false,
      );
      expect(shouldAutoAdvanceToReading(ReadingStatus.COMPLETED, 5, null)).toBe(
        false,
      );
    });

    it('toStateResponse should normalize raw DB state without throwing on cached string dates', () => {
      const rawCachedState = {
        readStatus: 'reading',
        rating: 4,
        currentPage: 15,
        scrollPosition: { top: 300 },
        lastOpenedAt: '2026-09-19T08:00:00.000Z' as any,
        lastReadAt: '2026-09-19T08:30:00.000Z' as any,
      };

      const res = toStateResponse(rawCachedState);
      expect(res.readStatus).toBe(ReadingStatus.READING);
      expect(res.rating).toBe(4);
      expect(res.currentPage).toBe(15);
      expect(res.lastOpenedAt).toBe('2026-09-19T08:00:00.000Z');
      expect(res.lastReadAt).toBe('2026-09-19T08:30:00.000Z');
    });
  });

  describe('StateService Operations & Scoping', () => {
    const mockUserId = '11111111-1111-4111-8111-111111111111';
    const mockProjectId = '22222222-2222-4222-8222-222222222222';
    const mockItemId = '33333333-3333-4333-8333-333333333333';

    let service: StateService;
    let repo: jest.Mocked<StateRepository>;
    let mockItemExistencePort: { assertExists: jest.Mock };
    let mockHelpers: jest.Mocked<TransactionHelpers>;
    let mockLibraryTx: { executeInTransaction: jest.Mock };

    beforeEach(async () => {
      mockHelpers = {
        appendChange: jest.fn().mockResolvedValue({} as any),
        recordTombstone: jest.fn().mockResolvedValue({} as any),
        publishOutbox: jest.fn().mockResolvedValue({} as any),
      };

      mockLibraryTx = {
        executeInTransaction: jest
          .fn()
          .mockImplementation((cb: any) => cb({}, mockHelpers)),
      };

      mockItemExistencePort = {
        assertExists: jest.fn().mockResolvedValue(undefined),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          StateService,
          {
            provide: StateRepository,
            useValue: {
              findState: jest.fn(),
              findStatesForItems: jest.fn(),
              upsertState: jest.fn(),
              deleteState: jest.fn(),
            },
          },
          { provide: TransactionService, useValue: mockLibraryTx },
          { provide: PrismaService, useValue: {} },
          { provide: ITEM_EXISTENCE_PORT, useValue: mockItemExistencePort },
        ],
      }).compile();

      service = module.get<StateService>(StateService);
      repo = module.get(StateRepository);
    });

    it('getState should assert item exists with projectId and return StateData', async () => {
      repo.findState.mockResolvedValue({
        id: 'st-1',
        userId: mockUserId,
        itemId: mockItemId,
        readStatus: 'reading',
        rating: 5,
        currentPage: 12,
        scrollPosition: null,
        lastOpenedAt: new Date(),
        lastReadAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const state = await service.getState(
        mockUserId,
        mockItemId,
        mockProjectId,
      );

      expect(mockItemExistencePort.assertExists).toHaveBeenCalledWith(
        mockUserId,
        mockItemId,
        mockProjectId,
      );
      expect(state.readStatus).toBe(ReadingStatus.READING);
      expect(state.rating).toBe(5);
      expect(state.currentPage).toBe(12);
    });

    it('updateState should reject invalid ratings and pages with BadRequestException', async () => {
      await expect(
        service.updateState(mockUserId, mockItemId, { rating: 7 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateState(mockUserId, mockItemId, { currentPage: 0 }),
      ).rejects.toThrow(BadRequestException);

      const hugeScroll = { data: 'a'.repeat(20000) };
      await expect(
        service.updateState(mockUserId, mockItemId, {
          scrollPosition: hugeScroll,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updateState should auto-advance to reading and propagate projectId to outbox event', async () => {
      repo.findState.mockResolvedValue({
        readStatus: 'unread',
        rating: 0,
        currentPage: 1,
      } as any);

      repo.upsertState.mockResolvedValue({
        id: 'st-1',
        userId: mockUserId,
        itemId: mockItemId,
        readStatus: 'reading',
        rating: 3,
        currentPage: 4,
        scrollPosition: { top: 100 },
        lastOpenedAt: new Date(),
        lastReadAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const result = await service.updateState(
        mockUserId,
        mockItemId,
        { currentPage: 4, rating: 3 },
        mockProjectId,
      );

      expect(repo.upsertState).toHaveBeenCalledWith(
        mockUserId,
        mockItemId,
        expect.objectContaining({
          readStatus: ReadingStatus.READING,
          currentPage: 4,
          rating: 3,
        }),
        expect.anything(),
      );

      expect(mockHelpers.appendChange).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        expect.objectContaining({
          entityType: 'State',
          action: 'update',
        }),
      );

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockItemId,
        'library.reading.updated',
        expect.objectContaining({
          itemId: mockItemId,
          userId: mockUserId,
          projectId: mockProjectId,
          readStatus: 'reading',
        }),
      );

      expect(result.readStatus).toBe(ReadingStatus.READING);
    });

    it('markAsRead should advance to reading and emit outbox event with projectId', async () => {
      repo.findState.mockResolvedValue({
        readStatus: 'unread',
      } as any);

      repo.upsertState.mockResolvedValue({
        id: 'st-1',
        userId: mockUserId,
        itemId: mockItemId,
        readStatus: 'reading',
        rating: 0,
        currentPage: 1,
        scrollPosition: null,
        lastOpenedAt: new Date(),
        lastReadAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await service.markAsRead(mockUserId, mockItemId, mockProjectId);

      expect(mockHelpers.publishOutbox).toHaveBeenCalledWith(
        { userId: mockUserId, projectId: mockProjectId },
        mockItemId,
        'library.reading.updated',
        expect.objectContaining({
          readStatus: 'reading',
          projectId: mockProjectId,
        }),
      );
    });

    it('getBatchStates should return default unread states for missing items', async () => {
      repo.findStatesForItems.mockResolvedValue([
        {
          id: 'st-1',
          userId: mockUserId,
          itemId: 'item-1',
          readStatus: 'reading',
          rating: 4,
          currentPage: 8,
          scrollPosition: null,
          lastOpenedAt: new Date(),
          lastReadAt: new Date(),
          updatedAt: new Date(),
        } as any,
      ]);

      const result = await service.getBatchStates(mockUserId, [
        'item-1',
        'item-2',
      ]);

      expect(result['item-1'].readStatus).toBe(ReadingStatus.READING);
      expect(result['item-1'].rating).toBe(4);
      expect(result['item-2'].readStatus).toBe(ReadingStatus.UNREAD);
      expect(result['item-2'].rating).toBe(0);
    });

    it('transferUserItemStates should not self-delete target item when targetItemId is in sourceItemIds', async () => {
      const mockTx = {
        state: {
          findMany: jest.fn().mockResolvedValue([
            {
              userId: mockUserId,
              itemId: 'item-dup-1',
              rating: 4,
              readStatus: 'reading',
              currentPage: 10,
              scrollPosition: null,
              lastOpenedAt: new Date('2026-09-10'),
              lastReadAt: new Date('2026-09-10'),
            },
            {
              userId: mockUserId,
              itemId: 'item-dup-2',
              rating: 5,
              readStatus: 'completed',
              currentPage: 25,
              scrollPosition: { top: 50 },
              lastOpenedAt: new Date('2026-09-15'),
              lastReadAt: new Date('2026-09-15'),
            },
          ]),
          upsert: jest.fn().mockResolvedValue({}),
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
      } as any;

      // Notice 'item-target' is mistakenly passed in sourceItemIds
      await service.transferUserItemStates(
        mockTx,
        ['item-dup-1', 'item-dup-2', 'item-target'],
        'item-target',
      );

      // Verify upsert picked the highest rating (5), completed status, and max page (25)
      expect(mockTx.state.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId_itemId: {
              userId: mockUserId,
              itemId: 'item-target',
            },
          },
          create: expect.objectContaining({
            rating: 5,
            readStatus: 'completed',
            currentPage: 25,
          }),
        }),
      );

      // Verify deleteMany explicitly did NOT delete 'item-target'
      expect(mockTx.state.deleteMany).toHaveBeenCalledWith({
        where: {
          itemId: {
            in: ['item-dup-1', 'item-dup-2'],
          },
        },
      });
    });
  });
});
