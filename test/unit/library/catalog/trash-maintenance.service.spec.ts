import { TrashMaintenanceService } from '@/modules/library/catalog/services/trash-maintenance.service';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import * as workerModeUtil from '@/core/utils/worker-mode.util';

describe('TrashMaintenanceService (Zotero Parity Auto-Purge)', () => {
  let service: TrashMaintenanceService;
  let mockItemService: Partial<jest.Mocked<ItemService>>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockItemService = {
      purgeExpiredTrash: jest.fn().mockResolvedValue({
        purgedItems: 5,
        purgedNotes: 2,
        purgedCollections: 1,
        storagePaths: ['file-1', 'file-2'],
        expiredItems: [],
        expiredNotes: [],
        expiredCollections: [],
      }),
    };

    service = new TrashMaintenanceService(mockItemService as ItemService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('runMaintenanceCycle', () => {
    it('should invoke itemService.purgeExpiredTrash with default retention of 30 days', async () => {
      const result = await service.runMaintenanceCycle();

      expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(30, 500);
      expect(result).toEqual({
        purgedItems: 5,
        purgedNotes: 2,
        purgedCollections: 1,
        storagePaths: ['file-1', 'file-2'],
      });
    });

    it('should respect custom retentionDays and limit arguments', async () => {
      await service.runMaintenanceCycle(60, 100);

      expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(60, 100);
    });

    it('should skip execution if a maintenance cycle is already in progress', async () => {
      let resolveFirstCall: (value: any) => void;
      const delayedPromise = new Promise((resolve) => {
        resolveFirstCall = resolve;
      });

      (mockItemService.purgeExpiredTrash as jest.Mock).mockImplementationOnce(
        () => delayedPromise,
      );

      // Start first cycle (in progress)
      const firstRun = service.runMaintenanceCycle();

      // Trigger second cycle immediately
      const secondRun = await service.runMaintenanceCycle();

      expect(secondRun).toEqual({
        purgedItems: 0,
        purgedNotes: 0,
        purgedCollections: 0,
        storagePaths: [],
      });
      expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledTimes(1);

      // Resolve first call
      resolveFirstCall!({
        purgedItems: 1,
        purgedNotes: 0,
        purgedCollections: 0,
        storagePaths: [],
      });
      await firstRun;
    });

    it('should handle errors gracefully without throwing', async () => {
      (mockItemService.purgeExpiredTrash as jest.Mock).mockRejectedValueOnce(
        new Error('Database lock timeout'),
      );

      const result = await service.runMaintenanceCycle();

      expect(result).toEqual({
        purgedItems: 0,
        purgedNotes: 0,
        purgedCollections: 0,
        storagePaths: [],
      });
    });
  });

  describe('Lifecycle & Scheduling', () => {
    it('should skip bootstrap scheduling if shouldRunWorkerConsumers returns false', async () => {
      jest.spyOn(workerModeUtil, 'shouldRunWorkerConsumers').mockReturnValue(false);

      await service.onApplicationBootstrap();

      jest.advanceTimersByTime(120_000);
      expect(mockItemService.purgeExpiredTrash).not.toHaveBeenCalled();
    });

    it('should schedule initial run after 60s delay when shouldRunWorkerConsumers returns true', async () => {
      jest.spyOn(workerModeUtil, 'shouldRunWorkerConsumers').mockReturnValue(true);

      await service.onApplicationBootstrap();

      expect(mockItemService.purgeExpiredTrash).not.toHaveBeenCalled();

      // Advance by 60 seconds
      await jest.advanceTimersByTimeAsync(60_000);

      expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(30, 500);
    });

    it('should clear timer on application shutdown or module destroy', async () => {
      jest.spyOn(workerModeUtil, 'shouldRunWorkerConsumers').mockReturnValue(true);

      await service.onApplicationBootstrap();
      service.onApplicationShutdown();

      // Advance past delay
      await jest.advanceTimersByTimeAsync(120_000);

      expect(mockItemService.purgeExpiredTrash).not.toHaveBeenCalled();
    });
  });
});
