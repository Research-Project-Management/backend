import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StateService } from '../../src/modules/library/state/state.service';
import { StateRepository } from '../../src/modules/library/state/state.repository';
import { ReadingStatus } from '../../src/modules/library/state/types/state.types';
import {
  isValidRating,
  isValidCurrentPage,
  isValidStateTransition,
  shouldAutoAdvanceToReading,
  toStateResponse,
} from '../../src/modules/library/state/utils/state.utils';

describe('Library State Module Unit Tests', () => {
  describe('Pure Utility Functions', () => {
    describe('isValidRating', () => {
      it('accepts undefined, null, and integers 0 to 5', () => {
        expect(isValidRating(undefined)).toBe(true);
        expect(isValidRating(null)).toBe(true);
        expect(isValidRating(0)).toBe(true);
        expect(isValidRating(3)).toBe(true);
        expect(isValidRating(5)).toBe(true);
      });

      it('rejects numbers outside 0..5 or non-integers', () => {
        expect(isValidRating(-1)).toBe(false);
        expect(isValidRating(6)).toBe(false);
        expect(isValidRating(3.5)).toBe(false);
      });
    });

    describe('isValidCurrentPage', () => {
      it('accepts undefined, null, and integers >= 1', () => {
        expect(isValidCurrentPage(undefined)).toBe(true);
        expect(isValidCurrentPage(null)).toBe(true);
        expect(isValidCurrentPage(1)).toBe(true);
        expect(isValidCurrentPage(100)).toBe(true);
      });

      it('rejects 0, negative numbers, and non-integers', () => {
        expect(isValidCurrentPage(0)).toBe(false);
        expect(isValidCurrentPage(-5)).toBe(false);
        expect(isValidCurrentPage(1.5)).toBe(false);
      });
    });

    describe('isValidStateTransition', () => {
      it('allows same state transitions', () => {
        expect(isValidStateTransition(ReadingStatus.UNREAD, ReadingStatus.UNREAD)).toBe(true);
        expect(isValidStateTransition(ReadingStatus.READING, ReadingStatus.READING)).toBe(true);
        expect(isValidStateTransition(ReadingStatus.COMPLETED, ReadingStatus.COMPLETED)).toBe(true);
      });

      it('allows standard forward and backward transitions', () => {
        expect(isValidStateTransition(ReadingStatus.UNREAD, ReadingStatus.READING)).toBe(true);
        expect(isValidStateTransition(ReadingStatus.READING, ReadingStatus.COMPLETED)).toBe(true);
        expect(isValidStateTransition(ReadingStatus.COMPLETED, ReadingStatus.READING)).toBe(true);
      });
    });

    describe('shouldAutoAdvanceToReading', () => {
      it('advances to reading when unread and moved past page 1', () => {
        expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 2)).toBe(true);
        expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 10)).toBe(true);
      });

      it('does not advance when on page 1 without scroll', () => {
        expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 1)).toBe(false);
        expect(shouldAutoAdvanceToReading(ReadingStatus.UNREAD, undefined)).toBe(false);
      });

      it('advances when scrollPosition is provided on unread item', () => {
        expect(
          shouldAutoAdvanceToReading(ReadingStatus.UNREAD, 1, { scrollY: 100 }),
        ).toBe(true);
      });

      it('does not advance if already reading or completed', () => {
        expect(shouldAutoAdvanceToReading(ReadingStatus.READING, 5)).toBe(false);
        expect(shouldAutoAdvanceToReading(ReadingStatus.COMPLETED, 5)).toBe(false);
      });
    });

    describe('toStateResponse', () => {
      it('returns sensible defaults when input is null or undefined', () => {
        const res = toStateResponse(null);
        expect(res.readStatus).toBe(ReadingStatus.UNREAD);
        expect(res.rating).toBe(0);
        expect(res.currentPage).toBe(1);
        expect(res.scrollPosition).toBeNull();
        expect(res.lastOpenedAt).toBeNull();
        expect(res.lastReadAt).toBeNull();
      });

      it('formats valid entity correctly with ISO strings', () => {
        const opened = new Date('2026-09-13T10:00:00Z');
        const read = new Date('2026-09-13T09:30:00Z');
        const res = toStateResponse({
          readStatus: 'reading',
          rating: 4,
          currentPage: 7,
          scrollPosition: { pageNumber: 7, scrollY: 200 },
          lastOpenedAt: opened,
          lastReadAt: read,
        });

        expect(res.readStatus).toBe(ReadingStatus.READING);
        expect(res.rating).toBe(4);
        expect(res.currentPage).toBe(7);
        expect(res.scrollPosition).toEqual({ pageNumber: 7, scrollY: 200 });
        expect(res.lastOpenedAt).toBe(opened.toISOString());
        expect(res.lastReadAt).toBe(read.toISOString());
      });
    });
  });

  describe('StateService Domain Logic', () => {
    let service: StateService;
    let mockRepo: any;
    let mockTxService: any;
    let mockPrisma: any;
    let mockItemExistencePort: any;

    const workspaceId = '00000000-0000-0000-0000-000000000001';
    const itemId = '11111111-1111-1111-1111-111111111111';
    const userId = '22222222-2222-2222-2222-222222222222';

    beforeEach(() => {
      mockRepo = {
        findState: jest.fn(),
        upsertState: jest.fn(),
        findStatesForItems: jest.fn(),
        deleteState: jest.fn(),
      };
      mockTxService = {
        executeInTransaction: jest.fn(async (cb) => {
          const fakeTx = {};
          const fakeHelpers = {
            appendChange: jest.fn().mockResolvedValue(undefined),
            publishOutbox: jest.fn().mockResolvedValue(undefined),
          };
          return cb(fakeTx, fakeHelpers);
        }),
      };
      mockPrisma = {
        workspace: {
          findFirst: jest.fn().mockResolvedValue({ id: workspaceId }),
        },
      };
      mockItemExistencePort = {
        assertExists: jest.fn().mockResolvedValue(undefined),
      };

      service = new StateService(
        mockRepo,
        mockTxService,
        mockPrisma,
        mockItemExistencePort,
      );
    });

    it('getState returns formatted StateData', async () => {
      mockRepo.findState.mockResolvedValueOnce({
        readStatus: 'reading',
        rating: 5,
        currentPage: 3,
        scrollPosition: { pageNumber: 3, scrollY: 150 },
        lastOpenedAt: new Date('2026-09-13T10:00:00Z'),
        lastReadAt: new Date('2026-09-13T10:00:00Z'),
      });

      const res = await service.getState(userId, itemId);

      expect(mockItemExistencePort.assertExists).toHaveBeenCalledWith(userId, itemId);
      expect(mockRepo.findState).toHaveBeenCalledWith(userId, itemId);
      expect(res.currentPage).toBe(3);
      expect(res.readStatus).toBe(ReadingStatus.READING);
      expect(res.rating).toBe(5);
    });

    it('throws BadRequestException when updating with invalid rating', async () => {
      await expect(
        service.updateState(userId, itemId, { rating: 10 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when updating with invalid currentPage', async () => {
      await expect(
        service.updateState(userId, itemId, { currentPage: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('auto-advances unread status to reading when user reads past page 1', async () => {
      mockRepo.findState.mockResolvedValueOnce(null); // currently unread
      mockRepo.upsertState.mockImplementationOnce((_user: any, _item: any, data: any) =>
        Promise.resolve({
          readStatus: data.readStatus,
          rating: data.rating ?? 0,
          currentPage: data.currentPage,
          scrollPosition: data.scrollPosition,
          lastOpenedAt: data.lastOpenedAt,
          lastReadAt: data.lastReadAt,
        }),
      );

      const res = await service.updateState(userId, itemId, {
        currentPage: 4,
      });

      expect(res.readStatus).toBe(ReadingStatus.READING);
      expect(res.currentPage).toBe(4);
      expect(mockRepo.upsertState).toHaveBeenCalledWith(
        userId,
        itemId,
        expect.objectContaining({
          readStatus: ReadingStatus.READING,
          currentPage: 4,
          lastOpenedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('markAsRead marks unread item as reading and sets lastReadAt', async () => {
      mockRepo.findState.mockResolvedValueOnce(null);
      mockRepo.upsertState.mockImplementationOnce((_user: any, _item: any, data: any) =>
        Promise.resolve({
          readStatus: data.readStatus,
          rating: 0,
          currentPage: 1,
          scrollPosition: null,
          lastOpenedAt: data.lastOpenedAt,
          lastReadAt: data.lastReadAt,
        }),
      );

      const res = await service.markAsRead(userId, itemId);

      expect(res.readStatus).toBe(ReadingStatus.READING);
      expect(mockRepo.upsertState).toHaveBeenCalledWith(
        userId,
        itemId,
        expect.objectContaining({
          readStatus: ReadingStatus.READING,
          lastReadAt: expect.any(Date),
          lastOpenedAt: expect.any(Date),
        }),
        expect.anything(),
      );
    });

    it('getBatchStates returns dictionary with defaults for missing items', async () => {
      mockRepo.findStatesForItems.mockResolvedValueOnce([
        {
          itemId: 'item-1',
          readStatus: 'completed',
          rating: 5,
          currentPage: 25,
          scrollPosition: null,
          lastOpenedAt: null,
          lastReadAt: null,
        },
      ]);

      const res = await service.getBatchStates(userId, ['item-1', 'item-2']);

      expect(res['item-1'].readStatus).toBe(ReadingStatus.COMPLETED);
      expect(res['item-1'].currentPage).toBe(25);
      expect(res['item-2'].readStatus).toBe(ReadingStatus.UNREAD);
      expect(res['item-2'].currentPage).toBe(1);
    });
  });
});
