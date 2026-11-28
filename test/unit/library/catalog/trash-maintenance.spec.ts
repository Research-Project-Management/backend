import { TrashMaintenanceService } from '@/modules/library/catalog/services/trash-maintenance.service';
import { ItemService } from '@/modules/library/catalog/services/items.service';
import * as workerModeUtil from '@/core/utils/worker-mode.util';

describe('TrashMaintenanceService', () => {
  let service: TrashMaintenanceService;
  let mockItemService: { purgeExpiredTrash: jest.Mock };

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

    service = new TrashMaintenanceService(
      mockItemService as unknown as ItemService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('purges expired trash with default (30d/500) or custom parameters and guards against overlapping runs or DB errors', async () => {
    const res = await service.runMaintenanceCycle();
    expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(30, 500);
    expect(res).toEqual({
      purgedItems: 5,
      purgedNotes: 2,
      purgedCollections: 1,
      storagePaths: ['file-1', 'file-2'],
    });

    await service.runMaintenanceCycle(60, 100);
    expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(60, 100);

    let resolvePending!: (val: unknown) => void;
    mockItemService.purgeExpiredTrash.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        }),
    );

    const firstRun = service.runMaintenanceCycle();
    const overlapping = await service.runMaintenanceCycle();
    expect(overlapping.purgedItems).toBe(0);

    resolvePending({
      purgedItems: 1,
      purgedNotes: 0,
      purgedCollections: 0,
      storagePaths: [],
    });
    await firstRun;

    mockItemService.purgeExpiredTrash.mockRejectedValueOnce(
      new Error('Lock timeout'),
    );
    expect((await service.runMaintenanceCycle()).purgedItems).toBe(0);
  });

  it('schedules initial purge after 60s only when worker consumers are enabled and clears timers on shutdown', async () => {
    jest
      .spyOn(workerModeUtil, 'shouldRunWorkerConsumers')
      .mockReturnValue(false);
    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockItemService.purgeExpiredTrash).not.toHaveBeenCalled();

    jest
      .spyOn(workerModeUtil, 'shouldRunWorkerConsumers')
      .mockReturnValue(true);
    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(mockItemService.purgeExpiredTrash).toHaveBeenCalledWith(30, 500);

    mockItemService.purgeExpiredTrash.mockClear();
    service.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(mockItemService.purgeExpiredTrash).not.toHaveBeenCalled();
  });
});
